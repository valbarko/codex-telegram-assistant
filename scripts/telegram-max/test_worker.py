import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import worker as w
from formatting import CHANNEL, CHANNEL_URL, Rich, compatible_formatting, from_source, render, rewrite
from transport import verify


class Platform:
    def __init__(self, root):
        self.root = root
        self.messages = []
        self.sends = 0
        self.edits = 0
        self.fail_create = False
        self.fail_get = False
        self.change_on_upload = None
        self.change_on_read = None

    def upload(self, media):
        if self.change_on_upload:
            self.change_on_upload()
        return 'RAM-only-upload-token'

    def api(self, method, path, query=None, body=None):
        if method == 'GET':
            if self.change_on_read:
                self.change_on_read()
                self.change_on_read = None
            return {'messages': copy.deepcopy(self.messages)}
        saved = w.load(self.root / 'state.json')
        # Independent assertion: intent was fsynced before the external write.
        assert saved['outbox'] is not None
        assert 'RAM-only-upload-token' not in json.dumps(saved)
        expected = saved['outbox']['expected']
        if method == 'POST':
            self.sends += 1
            ident = 'mid.' + str(self.sends)
            message = {'recipient': {'chat_id': CHANNEL}, 'sender': {'user_id': 405002207},
                       'timestamp': int(time.time()*1000), 'url': CHANNEL_URL+'/test'+str(self.sends),
                       'body': {'mid': ident, 'text': expected['text'], 'markup': expected['markup'],
                                'attachments': [{'type': typ, 'payload': {'id': i+7}}
                                                for i, typ in enumerate(saved['outbox']['types'])]}}
            self.messages.insert(0, message)
            if self.fail_create:
                self.fail_create = False
                raise TimeoutError('response lost after actual publication')
            return {'message': copy.deepcopy(message)}
        self.edits += 1
        message = next(m for m in self.messages if m['body']['mid'] == query['message_id'])
        message['body']['text'] = expected['text']
        message['body']['markup'] = expected['markup']
        return {'success': True}

    def get(self, ident):
        if self.fail_get:
            self.fail_get = False
            raise TimeoutError('read-back unavailable')
        return copy.deepcopy(next(m for m in self.messages if m['body']['mid'] == ident))


class QueueSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'inbox').mkdir()
        self.now = time.time()
        self.settings = {'source_chat': w.SOURCE_CHAT, 'max_chat': CHANNEL, 'enabled': True,
                         'baseline_id': 916, 'delay_seconds': 3600, 'interval_seconds': 3600,
                         'authorization': 'explicit test authorization'}
        w.atomic(self.root/'settings.json', self.settings)
        w.atomic(self.root/'state.json', w.new_state({'5': {'id': 'old', 'url': CHANNEL_URL+'/old'}}))
        w.atomic(self.root/'source-ready.json', {'at': self.now, 'ready': True, 'source_chat': w.SOURCE_CHAT})
        self.platform = Platform(self.root)

    def row(self, ident=917, text='Исходный текст', quiet=None, album='0', media=None):
        content = {'_': 'messageText', 'text': {'text': text, 'entities': []}}
        if media:
            content = {'_': 'messagePhoto', 'caption': {'text': text, 'entities': []}}
        row = {'source_chat': w.SOURCE_CHAT, 'id': ident, 'date': self.now-7200,
               'media_album_id': album, 'content': content, 'version': text+str(bool(media)),
               'quiet_since': self.now-3601 if quiet is None else quiet, 'validated_at': self.now}
        if media:
            row.update(media=media, media_version=row['version'])
        w.atomic(self.root/'inbox'/f'{ident}.json', row)
        return row

    def tick(self):
        with patch.object(w.time,'time',return_value=self.now):
            return w.tick(self.root, lambda root: self.platform, self.now)

    def advance(self, seconds):
        self.now += seconds
        w.atomic(self.root/'source-ready.json',{'at':self.now,'ready':True,'source_chat':w.SOURCE_CHAT})
        for path in (self.root/'inbox').glob('*.json'):
            row=w.load(path);row['validated_at']=self.now;w.atomic(path,row)

    def state(self):
        return w.load(self.root/'state.json')

    def test_waits_full_hour_and_uses_latest_edit(self):
        self.row(quiet=self.now-3599)
        self.assertEqual(self.tick()['status'], 'waiting')
        self.assertEqual(self.platform.sends, 0)
        self.row(text='Отредактированный текст', quiet=self.now-1)
        self.assertEqual(self.tick()['status'], 'waiting')
        self.advance(3601)
        self.assertEqual(self.tick()['status'], 'publish_verified')
        self.assertEqual(self.platform.messages[0]['body']['text'], 'Отредактированный текст')

    def test_two_posts_remain_ordered_and_at_least_an_hour_apart(self):
        self.row(917, 'Первый'); self.row(918, 'Второй')
        self.tick(); self.tick()
        self.assertEqual(self.platform.sends, 1)
        state = self.state(); state['last_publish_at'] = self.now-3601
        w.atomic(self.root/'state.json', state)
        self.platform.messages[0]['timestamp'] = int((self.now-3601)*1000)
        self.tick()
        self.assertEqual(self.platform.sends, 2)
        self.assertEqual(self.platform.messages[0]['body']['text'], 'Второй')

    def test_later_mature_post_cannot_overtake_earlier_edited_post(self):
        self.row(917, quiet=self.now-10); self.row(918, 'Поздний')
        self.tick()
        self.assertEqual(self.platform.sends, 0)

    def test_album_waits_for_last_member_and_keeps_media_order(self):
        media = {'path':'media/a.jpg','sha256':'a','type':'image'}
        self.row(917,'Подпись',album='123',media=media)
        self.row(918,'',quiet=self.now-20,album='123',media={**media,'sha256':'b'})
        self.tick(); self.assertEqual(self.platform.sends,0)
        self.advance(3601)
        self.tick()
        self.assertEqual(self.platform.sends,1)
        self.assertEqual(self.state()['completed']['album:123']['parts'][0]['media_hashes'],['a','b'])
        self.assertEqual(self.state()['mapping']['917'],self.state()['mapping']['918'])

    def test_restart_reuses_verified_receipt_without_duplicate(self):
        self.row(); self.tick(); self.tick()
        self.assertEqual(self.platform.sends,1)
        self.assertEqual(len(self.state()['completed']['post:917']['parts']),1)

    def test_lost_response_reconciles_actual_text_publication(self):
        self.row(); self.platform.fail_create=True
        with self.assertRaises(TimeoutError): self.tick()
        self.assertIsNotNone(self.state()['outbox'])
        self.assertEqual(self.tick()['status'],'reconciled')
        self.tick(); self.assertEqual(self.platform.sends,1)

    def test_lost_media_response_never_blindly_retries(self):
        self.row(media={'type':'image','sha256':'a','path':'media/a.jpg'})
        self.platform.fail_create=True
        with self.assertRaises(TimeoutError): self.tick()
        with self.assertRaisesRegex(ValueError,'resend blocked'): self.tick()
        self.assertEqual(self.platform.sends,1)

    def test_failed_readback_uses_saved_id_and_never_resends(self):
        self.row(); self.platform.fail_get=True
        with self.assertRaises(TimeoutError): self.tick()
        self.assertEqual(self.state()['outbox']['message_id'],'mid.1')
        self.assertEqual(self.tick()['status'],'reconciled')
        self.assertEqual(self.platform.sends,1)

    def test_no_candidate_does_not_clear_uncertain_send(self):
        self.row(); self.platform.fail_create=True
        with self.assertRaises(TimeoutError): self.tick()
        self.platform.messages=[]
        with self.assertRaisesRegex(ValueError,'resend blocked'): self.tick()
        self.assertIsNotNone(self.state()['outbox'])
        self.assertEqual(self.platform.sends,1)

    def test_edits_update_known_id_only_after_another_quiet_hour(self):
        self.row(); self.tick()
        self.row(text='Правка',quiet=self.now-10); self.tick()
        self.assertEqual(self.platform.edits,0)
        self.advance(3601); self.tick()
        self.assertEqual(self.platform.edits,1)
        self.assertEqual(self.platform.sends,1)
        self.assertEqual(self.platform.messages[0]['body']['mid'],'mid.1')

    def test_source_edit_during_upload_cancels_send_before_outbox(self):
        self.row(media={'type':'image','sha256':'a','path':'media/a.jpg'})
        self.platform.change_on_upload=lambda:self.row(text='Новая версия',quiet=self.now)
        self.assertEqual(self.tick()['status'],'source_changed_or_stale')
        self.assertEqual(self.platform.sends,0)
        self.assertIsNone(self.state()['outbox'])

    def test_edit_during_final_max_read_cancels_before_post(self):
        self.row()
        self.platform.change_on_read=lambda:self.row(text='Последняя правка',quiet=self.now)
        self.assertEqual(self.tick()['status'],'source_changed_or_stale')
        self.assertEqual(self.platform.sends,0)
        self.assertIsNone(self.state()['outbox'])

    def test_pause_during_upload_cancels_before_post(self):
        self.row(media={'type':'image','sha256':'a','path':'media/a.jpg'})
        self.platform.change_on_upload=lambda:w.atomic(self.root/'settings.json',{**self.settings,'enabled':False})
        self.assertEqual(self.tick()['status'],'source_changed_or_stale')
        self.assertEqual(self.platform.sends,0)
        self.assertIsNone(self.state()['outbox'])

    def test_fresh_source_required_and_archive_cannot_be_reimported(self):
        self.row(916,'Архив'); self.tick()
        self.assertEqual(self.platform.sends,0)
        self.row(); w.atomic(self.root/'source-ready.json',{'at':self.now-121,'ready':True,'source_chat':w.SOURCE_CHAT})
        self.assertEqual(self.tick()['status'],'waiting_for_fresh_source')

    def test_source_deletion_before_send_cancels_only_pending_copy(self):
        row=self.row(); w.atomic(self.root/'inbox/917.json',{**row,'deleted':True})
        self.tick(); self.assertEqual(self.platform.sends,0)

    def test_deleting_one_pending_album_member_does_not_block_remaining_member(self):
        media={'type':'image','sha256':'a','path':'media/a.jpg'}
        self.row(917,'Подпись',album='123',media=media)
        row=self.row(918,'',album='123',media=media)
        w.atomic(self.root/'inbox/918.json',{**row,'deleted':True})
        self.assertEqual(self.tick()['status'],'publish_verified')
        self.assertEqual(self.state()['units']['album:123']['source_ids'],[917])

    def test_continuation_parts_also_wait_an_hour_and_gain_navigation_links(self):
        self.row(text='Абзац. '*900)
        self.tick(); self.tick()
        self.assertEqual(self.platform.sends,1)
        self.advance(3601)
        self.tick()
        self.assertEqual(self.platform.sends,2)
        self.assertIn('← Начало',self.platform.messages[0]['body']['text'])
        self.tick()
        self.assertEqual(self.platform.sends,2)
        self.assertIn('Продолжение →',self.platform.messages[1]['body']['text'])

    def test_missing_media_does_not_publish_a_text_fragment(self):
        row=self.row(media={'type':'image','sha256':'a','path':'media/a.jpg'})
        del row['media']; w.atomic(self.root/'inbox/917.json',row)
        self.assertEqual(self.tick()['status'],'waiting_for_media')
        self.assertEqual(self.platform.sends,0)

    def test_manual_max_post_also_reserves_the_one_hour_interval(self):
        self.row()
        self.platform.messages=[{'timestamp':int((self.now-30)*1000),'body':{'mid':'manual'}}]
        self.assertEqual(self.tick()['status'],'waiting_for_channel_interval')
        self.assertEqual(self.platform.sends,0)

    def test_settings_cannot_silently_reduce_delay_or_change_destination(self):
        for key,value in [('delay_seconds',3599),('interval_seconds',3599),('max_chat',1),('source_chat',1)]:
            with self.subTest(key=key):
                w.atomic(self.root/'settings.json',{**self.settings,key:value})
                with self.assertRaises(ValueError): self.tick()
        self.assertEqual(self.platform.sends,0)

    def test_links_to_imported_archive_are_rewritten_to_max(self):
        row=self.row(text='Читать')
        row['content']['text']['entities']=[{'offset':0,'length':6,'type':{'_':'textEntityTypeTextUrl','url':'https://t.me/valbarkoclub/5'}}]
        w.atomic(self.root/'inbox/917.json',row)
        self.tick()
        self.assertEqual(self.platform.messages[0]['body']['markup'],[{'type':'link','from':0,'length':6,'url':CHANNEL_URL+'/old'}])

    def test_wrong_channel_or_changed_media_fails_verification(self):
        expected={'text':'Текст','markup':[]}
        message={'recipient':{'chat_id':123},'body':{'mid':'x','text':'Текст','attachments':[]},'url':CHANNEL_URL+'/x'}
        with self.assertRaises(ValueError): verify(message,expected,[])
        message['recipient']['chat_id']=CHANNEL
        message['body']['attachments']=[{'type':'image','payload':{'photo_id':10}}]
        with self.assertRaises(ValueError): verify(message,expected,['image'],[{'type':'image','photo_id':11}])

    def test_utf16_custom_emoji_fallback_and_nested_link_ranges(self):
        message={'content':{'_':'messageText','text':{'text':'💪 Сайт','entities':[
            {'offset':0,'length':2,'type':{'_':'textEntityTypeCustomEmoji','custom_emoji_id':'new'}},
            {'offset':3,'length':4,'type':{'_':'textEntityTypeBold'}},
            {'offset':3,'length':4,'type':{'_':'textEntityTypeTextUrl','url':'https://valbarko.ru/'}}]}}}
        rich=from_source(message,{})
        self.assertEqual(rich.text,'💪 Сайт')
        self.assertIn({'type':'strong','from':3,'length':4},rich.markup())
        self.assertIn('<a href="https://valbarko.ru/"><b>Сайт</b></a>',rich.html())

    def test_quote_code_and_contact_keep_exact_visible_text(self):
        text='Цитата\n\n  код \n@va_1entin'
        rich=Rich(text,[{'start':0,'end':6,'kind':'quote'}, {'start':8,'end':15,'kind':'monospaced'},
                       {'start':15,'end':len(text),'kind':'link','url':'https://t.me/va_1entin'}])
        result=compatible_formatting(rich)
        self.assertEqual(result.text,text)
        self.assertIn('<i>Цитата</i>',result.html())
        self.assertNotIn('blockquote',result.html())


if __name__ == '__main__':
    unittest.main()
