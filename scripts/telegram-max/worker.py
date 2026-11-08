#!/usr/bin/env python3
"""Durable, serialized, one-hour delayed Telegram → MAX outbox.

No API call can reset an uncertain POST. A receipt is committed only after a
fresh GET verifies text, formatting, destination and stable attachment IDs.
"""
from __future__ import annotations

import argparse
from dataclasses import asdict
import fcntl
import json
import os
from pathlib import Path
import time

from formatting import CHANNEL, SOURCE_CHAT, Rich, digest, from_source, render, split_rich
from transport import ApiError, Max, identities, media_for_transport, verify

HOUR = 3600
SUPPORTED = {'messageText', 'messagePhoto', 'messageVideo', 'messageVideoNote',
             'messageAnimation', 'messageAudio', 'messageVoiceNote', 'messageDocument', 'messagePoll'}


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return default


def atomic(path, value):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    with tmp.open('w') as stream:
        os.chmod(tmp, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def journal(root, event, **fields):
    with (root / 'journal.jsonl').open('a') as stream:
        stream.write(json.dumps({'at': time.time(), 'event': event, **fields}, ensure_ascii=False) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def validate_settings(settings):
    if settings['source_chat'] != SOURCE_CHAT or settings['max_chat'] != CHANNEL:
        raise ValueError('Destination identity changed')
    if settings['delay_seconds'] < HOUR or settings['interval_seconds'] < HOUR:
        raise ValueError('The authorized one-hour minimum cannot be reduced')
    if not settings.get('authorization') or settings['baseline_id'] < 1:
        raise ValueError('Missing standing authorization or baseline')


def new_state(mapping):
    return {'schema': 1, 'mapping': mapping, 'units': {}, 'completed': {},
            'outbox': None, 'last_publish_at': 0, 'created_at': time.time()}


def snapshots(root, settings):
    result = {}
    for path in sorted((root / 'inbox').glob('*.json')):
        row = load(path)
        if row['source_chat'] != SOURCE_CHAT or row['id'] <= settings['baseline_id']:
            continue
        result[str(row['id'])] = row
    return result


def prepare_units(rows, settings, state):
    groups = {}
    for row in sorted(rows.values(), key=lambda r: r['id']):
        album = str(row.get('media_album_id') or '0')
        key = 'album:' + album if album != '0' else 'post:' + str(row['id'])
        groups.setdefault(key, []).append(row)
    emoji_map = settings.get('emoji_map', {})
    for key, members in groups.items():
        live = [m for m in members if not m.get('deleted')]
        revision = digest([(m['id'], m['version'], bool(m.get('deleted'))) for m in members])
        prior = state['units'].get(key)
        if prior and prior['revision'] == revision:
            continue
        if not live:
            state['units'][key] = {'key': key, 'revision': revision, 'cancelled': True,
                                   'source_ids': [m['id'] for m in members], 'parts': []}
            continue
        rich = Rich('', [])
        error = None
        for member in live:
            if member['content']['_'] not in SUPPORTED:
                error = 'unsupported_source_type'
                continue
            part = from_source(member, emoji_map)
            offset = len(rich.text) + (2 if rich.text else 0)
            rich = Rich(rich.text + ('\n\n' if rich.text and part.text else '') + part.text,
                        rich.marks + [{**mark, 'start': mark['start'] + offset,
                                       'end': mark['end'] + offset} for mark in part.marks])
        unit = {'key': key, 'revision': revision, 'cancelled': False,
                'source_ids': [m['id'] for m in live],
                'parts': [asdict(p) for p in split_rich(rich)],
                'quiet_since': max(m['quiet_since'] for m in members),
                'versions': {str(m['id']): m['version'] for m in live},
                'error': error}
        reply = next((m.get('reply_to') for m in live if m.get('reply_to')), None)
        if reply and reply.get('chat_id', SOURCE_CHAT) in {0, SOURCE_CHAT} and reply.get('message_id'):
            unit['reply_to'] = int(reply['message_id'] / 1048576)
        record = state['completed'].get(key, {'parts': []})
        if len(record['parts']) > len(unit['parts']):
            unit['error'] = 'edit_removes_published_parts_requires_review'
        if prior and prior.get('source_ids') != unit['source_ids'] and record['parts']:
            unit['error'] = 'published_album_members_changed_requires_review'
        state['units'][key] = unit


def mature(unit, rows, settings, timestamp):
    if timestamp < unit['quiet_since'] + settings['delay_seconds']:
        return False
    return all(0 <= timestamp - rows[ident].get('validated_at', 0) <= 120
               for ident in unit['versions'])


def media_for(unit, rows):
    media = []
    for ident in unit['source_ids']:
        row = rows[str(ident)]
        if row['content']['_'] in {'messageText', 'messagePoll'}:
            continue
        item = row.get('media')
        if not item or row.get('media_version') != row['version']:
            return None
        media.append(media_for_transport(item))
    return media


def unchanged(root, unit, settings, timestamp):
    """Recheck the source after uploads, before the durable send intent."""
    ready = load(root / 'source-ready.json', {})
    if not ready.get('ready') or not 0 <= timestamp - ready.get('at', 0) <= 120:
        return False
    for ident, version in unit['versions'].items():
        current = load(root / 'inbox' / (ident + '.json'))
        if (not current or current.get('deleted') or current['version'] != version
                or timestamp < current['quiet_since'] + settings['delay_seconds']
                or not 0 <= timestamp - current.get('validated_at', 0) <= 120):
            return False
    return True


def commit_receipt(root, state, client, message):
    outbox = state['outbox']
    previous = state['completed'].get(outbox['key'], {'parts': []})['parts']
    if outbox['operation'] == 'edit' and previous[outbox['part']]['media_hashes'] == outbox['media_hashes']:
        verify(message, outbox['expected'], outbox['types'], previous[outbox['part']]['media_identity'])
    receipt = verify(message, outbox['expected'], outbox['types'])
    readback = client.get(receipt['id'])
    verify(readback, outbox['expected'], outbox['types'], receipt['media_identity'])
    record = state['completed'].setdefault(outbox['key'], {'parts': []})
    value = {**receipt, 'content_hash': outbox['expected']['hash'],
             'media_hashes': outbox['media_hashes'], 'verified_at': time.time()}
    index = outbox['part']
    if outbox['operation'] == 'publish':
        if len(record['parts']) != index:
            raise ValueError('Nonsequential publication receipt')
        record['parts'].append(value)
        state['last_publish_at'] = time.time()
    else:
        if record['parts'][index]['id'] != receipt['id']:
            raise ValueError('Edit changed the existing post identity')
        record['parts'][index] = value
    unit = state['units'][outbox['key']]
    # Bind links once the first actual post exists, including split posts.
    for ident in unit['source_ids']:
        state['mapping'][str(ident)] = {k: record['parts'][0][k] for k in ('id', 'url')}
    operation = outbox['operation']
    state['outbox'] = None
    state.pop('error', None)
    atomic(root / 'state.json', state)
    journal(root, operation + '_verified', source_ids=unit['source_ids'], part=index,
            id=receipt['id'], url=receipt['url'])


def reconcile(root, state, client):
    outbox = state['outbox']
    ident = outbox.get('message_id')
    if ident:
        message = client.get(ident)
        commit_receipt(root, state, client, message)
        return
    # Attachment identity is unknown after a lost create response. Exact text
    # alone cannot identify an image/video-only post, so require manual review.
    if outbox['types']:
        raise ValueError('Ambiguous media send: review required; resend blocked')
    candidates = []
    for message in client.api('GET', '/messages', {'chat_id': CHANNEL, 'count': 100}).get('messages', []):
        if message.get('timestamp', 0) < outbox['started_ms'] - 5000:
            continue
        if message.get('sender', {}).get('user_id') != 405002207:
            continue
        if message.get('body', {}).get('mid') in outbox.get('before_ids', []):
            continue
        try:
            verify(message, outbox['expected'], [])
            candidates.append(message)
        except ValueError:
            pass
    if len(candidates) != 1:
        raise ValueError('Ambiguous send: review required; resend blocked')
    commit_receipt(root, state, client, candidates[0])


def choose(state, rows, settings, timestamp):
    for unit in sorted(state['units'].values(), key=lambda u: min(u['source_ids'])):
        record = state['completed'].get(unit['key'], {'parts': []})
        if unit.get('cancelled'):
            continue
        if unit.get('error'):
            return ('blocked', unit, 0, None)
        pending = len(record['parts']) < len(unit['parts'])
        needs_edit = next((i for i, receipt in enumerate(record['parts'])
                           if receipt['content_hash'] != render(unit, i, state)['hash']), None)
        if not mature(unit, rows, settings, timestamp):
            if pending or needs_edit is not None:
                return None  # Preserve source order, including quiet albums.
            continue
        if needs_edit is not None:
            return ('edit', unit, needs_edit, render(unit, needs_edit, state))
        if pending:
            if timestamp < state.get('last_publish_at', 0) + settings['interval_seconds']:
                return None
            index = len(record['parts'])
            return ('publish', unit, index, render(unit, index, state))
    return None


def execute(root, state, rows, settings, client, chosen):
    operation, unit, index, expected = chosen
    if operation == 'blocked':
        raise ValueError(unit['error'])
    media = media_for(unit, rows) if index == 0 else []
    if media is None:
        return 'waiting_for_media'
    hashes = [item['sha256'] for item in media]
    prior = state['completed'].get(unit['key'], {'parts': []})['parts']
    receipt = prior[index] if index < len(prior) else None
    replace_media = operation == 'publish' or receipt.get('media_hashes') != hashes
    attachments = ([{'type': item['type'], 'payload': {'token': client.upload(item)}} for item in media]
                   if replace_media else None)
    # Uploading a large video can cross a new edit or exhaust the freshness
    # lease. No message is attempted until another fresh source validation.
    if not unchanged(root, unit, settings, time.time()):
        return 'source_changed_or_stale'
    body = {'text': expected['html'] or None, 'format': 'html', 'notify': True}
    reply = state['mapping'].get(str(unit.get('reply_to')))
    if index == 0 and reply:
        body['link'] = {'type': 'reply', 'mid': reply['id']}
    if attachments is not None:
        body['attachments'] = attachments
    before = client.api('GET', '/messages', {'chat_id': CHANNEL, 'count': 100}) if operation == 'publish' else {}
    if operation == 'publish':
        latest = max((m.get('timestamp', 0) / 1000 for m in before.get('messages', [])), default=0)
        if time.time() < latest + settings['interval_seconds']:
            return 'waiting_for_channel_interval'
    outbox = {'operation': operation, 'key': unit['key'], 'part': index,
              'expected': expected, 'types': [item['type'] for item in media],
              'media_hashes': hashes, 'started_ms': int(time.time() * 1000),
              'message_id': receipt['id'] if receipt else None,
              'before_ids': [m.get('body', {}).get('mid') for m in before.get('messages', [])]}
    state['outbox'] = outbox
    atomic(root / 'state.json', state)  # fsync BEFORE every public write.
    try:
        if operation == 'publish':
            result = client.api('POST', '/messages', {'chat_id': CHANNEL, 'disable_link_preview': 'true'}, body)
            message = result.get('message')
            if not message or not message.get('body', {}).get('mid'):
                raise ValueError('Create returned no authoritative message identity')
            state['outbox']['message_id'] = message['body']['mid']
            atomic(root / 'state.json', state)
        else:
            result = client.api('PUT', '/messages', {'message_id': receipt['id'], 'disable_link_preview': 'true'}, body)
            if result.get('success') is False:
                raise ValueError('Edit rejected')
            message = client.get(receipt['id'])
        commit_receipt(root, state, client, message)
    except ApiError as error:
        # This specific semantic rejection guarantees no message was created.
        # All other errors leave the intent intact, including HTTP timeouts.
        if error.code == 'attachment.not.ready':
            state['outbox'] = None
            atomic(root / 'state.json', state)
        raise
    return operation + '_verified'


def tick(root, client_factory=Max, timestamp=None):
    timestamp = time.time() if timestamp is None else timestamp
    settings = load(root / 'settings.json')
    validate_settings(settings)
    state = load(root / 'state.json')
    if not settings.get('enabled'):
        return {'status': 'disabled'}
    if state.get('outbox'):
        reconcile(root, state, client_factory(root))
        return {'status': 'reconciled'}
    if state.get('paused_error'):
        return {'status': 'blocked', 'code': state['paused_error']}
    ready = load(root / 'source-ready.json', {})
    if (not ready.get('ready') or not 0 <= timestamp - ready.get('at', 0) <= 120
            or ready.get('source_chat') != SOURCE_CHAT):
        return {'status': 'waiting_for_fresh_source'}
    rows = snapshots(root, settings)
    prepare_units(rows, settings, state)
    atomic(root / 'state.json', state)
    chosen = choose(state, rows, settings, timestamp)
    if not chosen:
        status = 'waiting' if rows else 'idle'
    elif chosen[0] == 'blocked':
        raise ValueError(chosen[1]['error'])
    else:
        status = execute(root, state, rows, settings, client_factory(root), chosen)
    return {'status': status, 'units': len(state['units']),
            'published_parts': sum(len(r['parts']) for r in state['completed'].values()),
            'last_publish_at': state.get('last_publish_at', 0)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    os.umask(0o077)
    with (root / 'worker.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            result = tick(root)
            if result['status'] not in {'blocked', 'waiting_for_fresh_source'}:
                state = load(root / 'state.json')
                if state and state.get('consecutive_failures'):
                    state['consecutive_failures'] = 0
                    atomic(root / 'state.json', state)
        except Exception as error:
            # Transport exceptions can contain signed URLs. Never persist their
            # str/repr or traceback. The durable outbox retains safe evidence.
            state = load(root / 'state.json')
            code = ('ambiguous_send' if state and state.get('outbox') else
                    'max_api_' + str(error.status) + '_' + error.code if isinstance(error, ApiError)
                    else 'worker_' + type(error).__name__)
            result = {'status': 'blocked', 'code': code}
            if state:
                state['consecutive_failures'] = state.get('consecutive_failures', 0) + 1
                if state['consecutive_failures'] >= 6 and not state.get('outbox'):
                    state['paused_error'] = code
                atomic(root / 'state.json', state)
            journal(root, 'blocked', code=code)
        atomic(root / 'worker-health.json', {'at': time.time(), **result})
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
