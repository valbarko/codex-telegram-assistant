"""Official MAX transport. Credentials and upload URLs exist only in memory."""
from __future__ import annotations
import json
import mimetypes
import os
import re
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict
from formatting import CHANNEL, CHANNEL_URL, TAGS, digest, u16

sys.path.insert(0, os.environ.get('MAX_PUBLISHER_SCRIPTS', str(Path.home()/'.codex/skills/publish-valentin-article/scripts')))

def media_for_transport(media):
    # MAX's native audio uploader rejected the original WAV (source 302) with
    # HTTP 415 for both audio/x-wav and audio/wav. The file uploader accepts it
    # unchanged, retaining all original bytes instead of transcoding the audio.
    if media['type'] == 'audio' and Path(media['path']).suffix.lower() == '.wav':
        return {**media, 'type': 'file'}
    return media

class ApiError(RuntimeError):
    def __init__(self, status, code):
        self.status = status
        self.code = str(code) if re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', str(code)) else 'api_error'
        super().__init__(f'MAX HTTP {status}: {self.code}')

class Max:
    def __init__(self, root):
        global max_account, publisher
        import max_account
        import publish_article as publisher
        self.root = Path(root)
        info = max_account.activate_account('valbarko')
        if info['destination']['chat_id'] != CHANNEL: raise ValueError('Unexpected destination')
        if not {'write', 'read_all_messages', 'edit'}.issubset(info['permissions']): raise ValueError('Missing required permissions')
        self.token, self.destination = publisher.max_credentials()
    def api(self, method, path, query=None, body=None):
        if method not in {'GET', 'POST', 'PUT'}: raise ValueError('Disallowed method')
        url = publisher.MAX_API_BASE + path
        if query: url += '?' + urllib.parse.urlencode(query)
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else (b'' if method == 'POST' else None)
        req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': self.token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=90, context=publisher.max_ssl_context()) as response: result = json.load(response)
        except urllib.error.HTTPError as error:
            raw = error.read().decode('utf8', errors='replace')
            raise ApiError(error.code, publisher.max_error_code(raw) or 'http_error') from None
        if result.get('code') not in (None, 0, '0'): raise ApiError(200, str(result['code']))
        return result
    def upload(self, media):
        path = (self.root / media['path']).resolve()
        if not path.is_relative_to(self.root.resolve()): raise ValueError('Media outside private state directory')
        raw = path.read_bytes()
        if digest(raw) != media['sha256']: raise ValueError('Media hash changed before upload')
        typ = media['type']
        if typ in {'image', 'video'}: return publisher.max_upload_media(self.token, path, typ)
        slot = self.api('POST', '/uploads', {'type': typ}); parsed = urllib.parse.urlparse(slot.get('url', ''))
        allowed = parsed.hostname == 'fu.oneme.ru' if typ == 'file' else bool(parsed.hostname and parsed.hostname.endswith('.okcdn.ru'))
        if parsed.scheme != 'https' or not allowed or parsed.username or parsed.password: raise ValueError('Unexpected upload destination')
        boundary = '----max-migration-' + uuid.uuid4().hex
        filename = media.get('original_name') or path.name
        filename = filename.replace('"', '').replace('\r', '').replace('\n', '')
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="data"; filename="{filename}"\r\nContent-Type: {mimetypes.guess_type(filename)[0] or "application/octet-stream"}\r\n\r\n'.encode()
                + raw + f'\r\n--{boundary}--\r\n'.encode())
        req = urllib.request.Request(slot['url'], body, method='POST', headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        try:
            with urllib.request.urlopen(req, timeout=300, context=publisher.max_ssl_context()) as response:
                raw_response = response.read()
                try: result = json.loads(raw_response)
                except json.JSONDecodeError: result = {}
        except urllib.error.HTTPError as error: raise RuntimeError(f'Media upload HTTP {error.code}') from None
        def token(value):
            if isinstance(value, dict):
                if isinstance(value.get('token'), str): return value['token']
                for child in value.values():
                    found = token(child)
                    if found: return found
            return None
        found = token(result) or slot.get('token')
        if not found: raise ValueError('Upload response has no media token')
        return found
    def get(self, ident):
        result = self.api('GET', '/messages', {'message_ids': ident})
        messages = result.get('messages') or []
        if len(messages) != 1: raise ValueError('Published post is unavailable')
        return messages[0]

def normalized_markup(items):
    aliases = {'italic': 'emphasized', 'em': 'emphasized', 'code': 'monospaced', 'blockquote': 'quote'}
    groups = defaultdict(list)
    for item in items or []:
        typ = aliases.get(item['type'], item['type'])
        if typ not in set(TAGS) | {'link'}: continue
        start = item.get('from', 0); end = start + item.get('length', 0)
        if start < end: groups[(typ, item.get('url', '') if typ == 'link' else '')].append((start, end))
    result = []
    for (typ, url), spans in sorted(groups.items()):
        merged = []
        for a, b in sorted(spans):
            if merged and a <= merged[-1][1]: merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
            else: merged.append((a, b))
        result.extend((typ, url, a, b) for a, b in merged)
    return result

def identities(message):
    output = []
    for a in message.get('body', {}).get('attachments') or []:
        if a['type'] == 'share': continue
        p = a.get('payload') or {}
        output.append({'type': a['type'], **{k: p[k] for k in ['photo_id', 'id', 'filename', 'file_name', 'size', 'duration'] if k in p}})
    return output

def verify(message, expected, expected_types, stable=None):
    if message.get('recipient', {}).get('chat_id') != CHANNEL: raise ValueError('Wrong recipient')
    body = message.get('body') or {}
    if (body.get('text') or '').strip() != expected['text'].strip(): raise ValueError('Published visible text mismatch')
    # MAX trims boundary whitespace; account for that in expected offsets.
    leading = u16(expected['text']) - u16(expected['text'].lstrip())
    expected_marks = [{**m, 'from': m['from'] - leading} for m in expected['markup']]
    actual = normalized_markup(body.get('markup'))
    wanted = normalized_markup(expected_marks)
    if actual != wanted: raise ValueError('Published formatting mismatch: ' + repr({'expected': wanted[:8], 'actual': actual[:8]}))
    identity = identities(message)
    if [x['type'] for x in identity] != expected_types: raise ValueError('Published media order/type mismatch')
    if stable is not None and identity != stable: raise ValueError('Published media identity changed')
    ident = body.get('mid'); url = message.get('url')
    if not ident or not isinstance(url, str) or not url.startswith(CHANNEL_URL + '/'): raise ValueError('Missing canonical publication identity')
    return {'id': ident, 'url': url, 'media_identity': identity}
