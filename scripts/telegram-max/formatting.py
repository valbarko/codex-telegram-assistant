"""Lossless Telegram text ranges and verified MAX formatting compatibility."""
from __future__ import annotations
from dataclasses import dataclass
from collections import defaultdict
import hashlib
import html
import json
import re
import urllib.parse

CHANNEL = -70978688537928
CHANNEL_URL = 'https://max.ru/channel_valbarko'
SOURCE_CHAT = -1002359399843
TAGS = {'strong': ('<b>', '</b>'), 'emphasized': ('<i>', '</i>'),
        'underline': ('<u>', '</u>'), 'strikethrough': ('<s>', '</s>'),
        'monospaced': ('<code>', '</code>'), 'quote': ('<blockquote>', '</blockquote>')}
TYPE_MAP = {'textEntityTypeBold': 'strong', 'textEntityTypeItalic': 'emphasized',
            'textEntityTypeUnderline': 'underline', 'textEntityTypeStrikethrough': 'strikethrough',
            'textEntityTypeCode': 'monospaced', 'textEntityTypePre': 'monospaced',
            'textEntityTypePreCode': 'monospaced', 'textEntityTypeBlockQuote': 'quote',
            'textEntityTypeExpandableBlockQuote': 'quote'}

def digest(value):
    raw = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()
def u16(s): return len(s.encode('utf-16-le')) // 2
def index_at(s, offset): return len(s.encode('utf-16-le')[:offset * 2].decode('utf-16-le'))

@dataclass
class Rich:
    text: str
    marks: list[dict]

    def slice(self, start, end):
        marks = []
        for m in self.marks:
            a, b = max(start, m['start']), min(end, m['end'])
            if a < b: marks.append({**m, 'start': a - start, 'end': b - start})
        return Rich(self.text[start:end], marks)

    def replace(self, replacements):
        result = self
        for start, end, value in sorted(replacements, reverse=True):
            delta = len(value) - (end - start)
            def boundary(pos):
                if pos <= start: return pos
                if pos >= end: return pos + delta
                return start + len(value)
            result = Rich(result.text[:start] + value + result.text[end:],
                          [{**m, 'start': boundary(m['start']), 'end': boundary(m['end'])} for m in result.marks])
        return result

    def html(self):
        points = sorted({0, len(self.text), *(m[k] for m in self.marks for k in ['start', 'end'])})
        out, previous = [], []
        order = ['link', 'quote', 'strong', 'emphasized', 'underline', 'strikethrough', 'monospaced']
        for start, end in zip(points, points[1:]):
            active = [m for m in self.marks if m['start'] <= start and m['end'] >= end and m['end'] > m['start']]
            active.sort(key=lambda m: (order.index(m['kind']), m.get('url', '')))
            stack = []
            for m in active:
                tag = ('<a href="' + html.escape(m['url'], quote=True) + '">', '</a>') if m['kind'] == 'link' else TAGS[m['kind']]
                if tag not in stack: stack.append(tag)
            common = 0
            while common < min(len(previous), len(stack)) and previous[common] == stack[common]: common += 1
            out.extend(tag[1] for tag in reversed(previous[common:]))
            out.extend(tag[0] for tag in stack[common:])
            out.append(html.escape(self.text[start:end], quote=False))
            previous = stack
        out.extend(tag[1] for tag in reversed(previous))
        return ''.join(out)

    def markup(self):
        return [{'type': m['kind'], 'from': u16(self.text[:m['start']]),
                 'length': u16(self.text[m['start']:m['end']]),
                 **({'url': m['url']} if m['kind'] == 'link' else {})} for m in self.marks if m['start'] < m['end']]

def source_target(url):
    parsed = urllib.parse.urlparse(url if '://' in url else 'https://' + url)
    if parsed.netloc.lower() not in {'t.me', 'telegram.me', 'www.t.me'}: return None
    bits = parsed.path.strip('/').split('/')
    if bits[0].lower() == 'valbarkoclub':
        return int(bits[1]) if len(bits) > 1 and bits[1].isdigit() else 'channel'
    if len(bits) > 2 and bits[:2] == ['c', '2359399843'] and bits[2].isdigit(): return int(bits[2])
    return None

def formatted(message):
    c = message['content']
    return c.get('text') or c.get('caption') or c.get('description') or {'text': '', 'entities': []}

def from_source(message, emoji_map):
    c = message['content']
    if c['_'] == 'messagePoll':
        poll = c['poll']
        question = poll['question']['text']
        lines = [question, '']
        for i, option in enumerate(poll['options'], 1):
            value = option['text']; value = value['text'] if isinstance(value, dict) else value
            lines.append(f"{i}. {value} — {option['voter_count']}")
        lines.extend(['', f"Результаты опроса в Telegram: {poll['total_voter_count']} голосов."])
        return Rich('\n'.join(lines), [])
    f = formatted(message); text = f['text']; marks, replacements = [], []
    for e in f.get('entities', []):
        start = index_at(text, e['offset']); end = index_at(text, e['offset'] + e['length'])
        typ = e.get('type', {}); kind = typ.get('_')
        if kind in TYPE_MAP: marks.append({'start': start, 'end': end, 'kind': TYPE_MAP[kind]})
        elif kind in {'textEntityTypeTextUrl', 'textEntityTypeUrl', 'textEntityTypeMention'}:
            url = typ.get('url') or text[start:end]
            if kind == 'textEntityTypeMention': url = 'https://t.me/' + url.lstrip('@')
            elif '://' not in url and not url.startswith('mailto:'): url = 'https://' + url
            marks.append({'start': start, 'end': end, 'kind': 'link', 'url': url,
                          'bare': kind == 'textEntityTypeUrl'})
        elif kind == 'textEntityTypeCustomEmoji':
            ident = str(typ['custom_emoji_id'])
            replacements.append((start, end, emoji_map.get(ident, text[start:end])))
    rich = Rich(text, marks).replace(replacements)
    # Caption boundary whitespace is normalized once, before the approved plan is hashed.
    start = len(rich.text) - len(rich.text.lstrip()); end = len(rich.text.rstrip())
    return rich.slice(start, end)

def rewrite(rich, mapping, worst=False):
    replacements, marks = [], []
    for m in rich.marks:
        m = dict(m)
        if m['kind'] == 'link':
            target = source_target(m['url'])
            if target in {105, 203}: continue  # Known deleted sources: keep label, remove dead hyperlink.
            if target == 'channel': m['url'] = CHANNEL_URL
            elif target is not None:
                if worst: m['url'] = CHANNEL_URL + '/' + 'X' * 40
                elif str(target) in mapping: m['url'] = mapping[str(target)]['url']
            if m.get('bare') and target is not None and target not in {105, 203} and (worst or target == 'channel' or str(target) in mapping):
                replacements.append((m['start'], m['end'], m['url']))
        marks.append(m)
    return Rich(rich.text, marks).replace(replacements)

def split_rich(rich):
    if not rich.text: return [rich]
    if len(rewrite(rich, {}, True).html()) <= 4000: return [rich]
    parts, start = [], 0
    while start < len(rich.text):
        end = len(rich.text)
        if len(rewrite(rich.slice(start, end), {}, True).html()) > 3400:
            low, high = start + 1, end
            while low < high:
                middle = (low + high + 1) // 2
                if len(rewrite(rich.slice(start, middle), {}, True).html()) <= 3400: low = middle
                else: high = middle - 1
            end = low
            # Do not cut a link label or code unit sequence in the middle.
            for m in rich.marks:
                if m['kind'] == 'link' and m['start'] < end < m['end'] and m['start'] > start: end = m['start']
            paragraph = rich.text.rfind('\n\n', start + max(1, (end - start) // 2), end)
            if paragraph > start: end = paragraph + 2
            elif end < len(rich.text):
                line = rich.text.rfind('\n', start + max(1, (end - start) // 2), end)
                if line > start: end = line + 1
        if end <= start: raise ValueError('Cannot split content safely')
        parts.append(rich.slice(start, end)); start = end
    return parts

def append_link(rich, label, url):
    prefix = '\n\n' if rich.text else ''
    start = len(rich.text) + len(prefix)
    return Rich(rich.text + prefix + label, rich.marks + [{'start': start, 'end': start + len(label), 'kind': 'link', 'url': url}])

def compatible_formatting(rich):
    # The live channel API strips HTML <blockquote> and leaves Markdown ">"
    # literal (verified on source 71). Keep the exact quote text and paragraph
    # boundaries, and distinguish the quoted range with supported italics.
    marks = []
    for original in rich.marks:
        mark = {**original, 'kind': 'emphasized' if original['kind'] == 'quote' else original['kind']}
        # MAX interprets an anchor labelled exactly "@username" as a MAX
        # user_mention, even for an explicit Telegram URL. Keep the visible @
        # outside the anchor so the unchanged username remains a real external
        # hyperlink to the exact requested destination.
        if mark['kind'] == 'link' and mark['end'] - mark['start'] > 1 and rich.text[mark['start']] == '@':
            mark['start'] += 1
        # MAX strips line endings inside inline <code>. Keep all whitespace in
        # the original text, outside code tags, and format each visible line.
        if mark['kind'] == 'monospaced':
            for line in re.finditer(r'[^\r\n]+', rich.text[mark['start']:mark['end']]):
                start, end = mark['start'] + line.start(), mark['start'] + line.end()
                while start < end and rich.text[start].isspace(): start += 1
                while end > start and rich.text[end - 1].isspace(): end -= 1
                if start < end: marks.append({**mark, 'start': start, 'end': end})
            continue
        marks.append(mark)
    return Rich(rich.text, marks)

def add_attribution(rich, members, origins):
    seen = set()
    for member in members:
        origin = origins.get(str(member['id']), {})
        if origin.get('kind') != 'messageOriginChannel' or not origin.get('name'): continue
        key = (origin['name'], origin.get('url'))
        if key in seen: continue
        seen.add(key)
        prefix = ('\n\n' if rich.text else '') + 'Переслано из: '
        start = len(rich.text) + len(prefix)
        rich = Rich(rich.text + prefix + origin['name'], rich.marks +
                    ([{'start': start, 'end': start + len(origin['name']), 'kind': 'link', 'url': origin['url']}] if origin.get('url') else []))
    return rich

def render(unit, index, state):
    part = unit['parts'][index]; rich = rewrite(Rich(**part), state['mapping'])
    rich = compatible_formatting(rich)
    existing = state['completed'].get(unit['key'], {}).get('parts', [])
    if len(unit['parts']) > 1:
        if index > 0 and existing: rich = append_link(rich, '← Начало', existing[0]['url'])
        if index + 1 < len(existing): rich = append_link(rich, 'Продолжение →', existing[index + 1]['url'])
    # Whitespace between chunks belongs to the source structure, not the post edges.
    start = len(rich.text) - len(rich.text.lstrip()); end = len(rich.text.rstrip()); rich = rich.slice(start, end)
    payload = {'text': rich.text, 'html': rich.html(), 'markup': rich.markup()}
    if max(len(payload['html']), u16(payload['text'])) > 4000: raise ValueError('Rendered MAX part exceeds limit')
    payload['hash'] = digest(payload)
    return payload
