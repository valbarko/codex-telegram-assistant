#!/usr/bin/env python3
"""Install only this source-only channel bridge; never replace the assistant."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time

from formatting import CHANNEL, SOURCE_CHAT
from worker import atomic, load, new_state

LABEL = 'com.valbarko.telegram-max'
PROJECT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--owner-id', type=int)
    parser.add_argument('--remove', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    parser.add_argument('--enable', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    domain = 'gui/' + str(os.getuid())
    if args.remove:
        if plist.exists():
            existing = plistlib.loads(plist.read_bytes())
            if str(root) not in existing.get('ProgramArguments', []):
                raise ValueError('Refusing to remove an unrelated service')
            subprocess.run(['launchctl', 'bootout', domain + '/' + LABEL], capture_output=True)
            plist.unlink()
        print('Bridge stopped; durable queue and credentials retained')
        return
    os.umask(0o077)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    (root / 'inbox').mkdir(exist_ok=True, mode=0o700)
    (root / 'media').mkdir(exist_ok=True, mode=0o700)
    if not (root / 'settings.json').exists():
        if not args.archive:
            raise ValueError('A verified completed archive is required for the initial baseline')
        archive = args.archive.resolve()
        previous = load(archive / 'state.json')
        source = load(archive / 'telegram.json')
        audit = load(archive / 'final-audit.json')
        if (previous.get('phase') != 'complete' or len(previous['mapping']) != 766
                or previous.get('outbox') or not audit):
            raise ValueError('Archive completion is not verified')
        baseline = max(m['id'] for m in source['messages'])
        settings = {'schema': 1, 'enabled': not args.prepare_only, 'source_chat': SOURCE_CHAT, 'max_chat': CHANNEL,
                    'source_bot_id': 8778802126, 'baseline_id': baseline,
                    'delay_seconds': 3600, 'interval_seconds': 3600,
                    'owner_id': args.owner_id, 'python': sys.executable,
                    'emoji_map': load(archive / 'emoji-map.json', {}),
                    'authorization': 'Valentin explicitly authorized automatic copying of new valbarkoclub posts to channel_valbarko, one hour after the last edit and at least one hour between MAX publications, including implementation and production closeout in the current chat on 2026-11-08.'}
        state = new_state({key: {k: value[k] for k in ('id', 'url')} for key, value in previous['mapping'].items()})
        # Even the first automatic message must respect the last archive send.
        if previous.get('last_publish_at'):
            from datetime import datetime
            state['last_publish_at'] = datetime.fromisoformat(previous['last_publish_at']).timestamp()
        atomic(root / 'settings.json', settings)
        atomic(root / 'state.json', state)
    elif not (root / 'state.json').exists():
        raise ValueError('Existing settings without state: refusing to reset the queue')
    if args.prepare_only:
        print(json.dumps({'prepared': True, 'enabled': load(root/'settings.json')['enabled'], 'root': str(root)}))
        return
    node = shutil.which('node')
    if not node:
        raise ValueError('Node is unavailable')
    arguments = [sys.executable, str(PROJECT / 'scripts/telegram-max/run.py'), str(root),
                 node, str(PROJECT / 'node_modules/tsx/dist/cli.mjs'), str(PROJECT / 'scripts/telegram-max/source.mts')]
    if plist.exists():
        existing = plistlib.loads(plist.read_bytes())
        if str(root) not in existing.get('ProgramArguments', []):
            raise ValueError('Refusing to replace an unrelated service')
        subprocess.run(['launchctl', 'bootout', domain + '/' + LABEL], capture_output=True)
    data = {'Label': LABEL, 'ProgramArguments': arguments, 'WorkingDirectory': str(PROJECT),
            'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
            'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30, 'ProcessType': 'Background',
            'StandardOutPath': str(root / 'source.log'), 'StandardErrorPath': str(root / 'source-error.log')}
    plist.parent.mkdir(parents=True, exist_ok=True)
    with plist.open('wb') as stream:
        plistlib.dump(data, stream)
    plist.chmod(0o600)
    # launchd can briefly return EIO after a successful bootout while it
    # finishes unregistering the previous job. Retry this reversible start,
    # never reset publication state or touch another service.
    for attempt in range(5):
        result = subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], capture_output=True)
        if result.returncode == 0:
            break
        if attempt == 4:
            result.check_returncode()
        time.sleep(1)
    if args.enable:
        settings = load(root / 'settings.json')
        settings['enabled'] = True
        atomic(root / 'settings.json', settings)
    print(json.dumps({'service': LABEL, 'installed': True, 'root': str(root), 'baseline_id': load(root/'settings.json')['baseline_id']}))


if __name__ == '__main__':
    main()
