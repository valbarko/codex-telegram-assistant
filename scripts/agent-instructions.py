#!/usr/bin/env python3
"""Plan, install, verify, or restore the reviewed local instruction bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "config/agent-instructions/manifest.json"


class Conflict(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def current(path):
    if path.is_symlink():
        raise Conflict(f"Refusing a symlink target: {path}")
    if not path.exists():
        return None
    if not path.is_file():
        raise Conflict(f"Target is not a regular file: {path}")
    return digest(path.read_bytes())


def atomic_write(path, data, mode=0o600, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, mode)
        if expected is not None and current(path) != expected:
            raise Conflict(f"Live file changed before atomic restore: {path}")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load_entries(manifest, root=ROOT):
    document = json.loads(manifest.read_text())
    if document.get("version") != 1 or not isinstance(document.get("files"), list):
        raise Conflict("Unsupported instruction manifest")
    entries = []
    targets = set()
    for item in document["files"]:
        source = (root / item["source"]).resolve()
        if not source.is_relative_to(root.resolve()) or not source.is_file():
            raise Conflict(f"Source must be a file inside the reviewed checkout: {item['source']}")
        target = Path(item["target"])
        if not target.is_absolute() or target in targets:
            raise Conflict(f"Target must be unique and absolute: {target}")
        targets.add(target)
        data = source.read_bytes()
        if digest(data) != item["source_sha256"]:
            raise Conflict(f"Reviewed source checksum failed: {item['source']}")
        expected = item["expected_sha256"]
        if expected is not None and (not isinstance(expected, str) or len(expected) != 64):
            raise Conflict(f"Invalid baseline hash: {target}")
        entries.append({"source": item["source"], "target": target, "data": data,
                        "expected": expected, "after": digest(data)})
    return entries


def classify(entry):
    actual = current(entry["target"])
    if actual == entry["after"]:
        return "current"
    if actual != entry["expected"]:
        return "drift"
    return "create" if actual is None else "replace"


def plan(entries):
    result = [(entry, classify(entry)) for entry in entries]
    for entry, state in result:
        print(f"{state:7} {entry['target']}")
    return result


def save_journal(backup, journal):
    atomic_write(backup / "journal.json", (json.dumps(journal, indent=2) + "\n").encode())


def apply(entries, backup_root):
    states = plan(entries)
    conflicts = [entry for entry, state in states if state == "drift"]
    if conflicts:
        raise Conflict("Live instructions changed since the reviewed baseline; reconcile before applying")
    pending = [entry for entry, state in states if state != "current"]
    if not pending:
        print("All instruction files already match")
        return None
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="agent-instructions-", dir=backup_root))
    backup.chmod(0o700)
    journal = {"version": 1, "files": []}
    staged = []
    try:
        for index, entry in enumerate(pending):
            target = entry["target"]
            if current(target) != entry["expected"]:
                raise Conflict(f"Live file changed during backup: {target}")
            old = target.read_bytes() if entry["expected"] is not None else None
            mode = stat.S_IMODE(target.stat().st_mode) if old is not None else 0o600
            name = f"{index:03}.before"
            if old is not None:
                if digest(old) != entry["expected"]:
                    raise Conflict(f"Live file changed during snapshot: {target}")
                atomic_write(backup / name, old)
            record = {"target": str(target), "before": entry["expected"],
                      "after": entry["after"], "snapshot": name if old is not None else None,
                      "mode": mode, "applied": False}
            journal["files"].append(record)
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.reviewed-", dir=target.parent)
            with os.fdopen(fd, "wb") as output:
                output.write(entry["data"])
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, mode)
            staged.append((entry, Path(temporary), record))
        save_journal(backup, journal)
        verified = [entry for entry, state in states if state == "current"]
        for entry, temporary, record in staged:
            # Persist intent before the final checks; journal I/O can take time.
            record["applied"] = True
            save_journal(backup, journal)
            try:
                for installed in verified:
                    if current(installed["target"]) != installed["after"]:
                        raise Conflict(f"Installed reference changed: {installed['target']}")
                if current(entry["target"]) != entry["expected"]:
                    raise Conflict(f"Live file changed before replacement: {entry['target']}")
                if current(temporary) != entry["after"]:
                    raise Conflict(f"Staged content changed: {entry['target']}")
            except Conflict:
                # No rename occurred, so recovery must leave this target alone.
                record["applied"] = False
                raise
            os.replace(temporary, entry["target"])
            verified.append(entry)
        mismatches = [entry["target"] for entry in entries if current(entry["target"]) != entry["after"]]
        if mismatches:
            raise Conflict(f"Post-install drift detected: {mismatches[0]}")
        print(f"Installed {len(pending)} instruction files; backup: {backup}")
        return backup
    except Exception:
        save_journal(backup, journal)
        print(f"Apply stopped; recovery journal: {backup}", file=sys.stderr)
        raise
    finally:
        for _, temporary, _ in staged:
            if temporary.exists():
                temporary.unlink()


def rollback(backup):
    journal = json.loads((backup / "journal.json").read_text())
    if journal.get("version") != 1:
        raise Conflict("Unsupported recovery journal")
    pending = []
    for record in journal["files"]:
        if not record["applied"]:
            continue
        target = Path(record["target"])
        actual = current(target)
        if actual == record["before"]:
            continue
        if actual != record["after"]:
            raise Conflict(f"Preserve later edits before rollback: {target}")
        data = None
        if record["snapshot"] is not None:
            snapshot = (backup / record["snapshot"]).resolve()
            if not snapshot.is_relative_to(backup.resolve()):
                raise Conflict("Invalid snapshot location")
            data = snapshot.read_bytes()
            if digest(data) != record["before"]:
                raise Conflict(f"Snapshot checksum failed: {target}")
        pending.append((record, target, data))
    for record, target, data in reversed(pending):
        if current(target) != record["after"]:
            raise Conflict(f"Live file changed during rollback: {target}")
        if data is None:
            target.unlink()
        else:
            atomic_write(target, data, record["mode"], expected=record["after"])
    print(f"Restored {len(pending)} managed files; other directory entries preserved")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "apply", "check", "rollback"])
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--backup-root", type=Path, default=Path.home() / ".codex/backups")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "rollback":
            if args.backup is None:
                parser.error("rollback requires --backup")
            rollback(args.backup)
            return 0
        entries = load_entries(args.manifest)
        if args.command == "apply":
            apply(entries, args.backup_root)
            return 0
        states = plan(entries)
        if args.command == "check":
            return 0 if all(state == "current" for _, state in states) else 1
        return 2 if any(state == "drift" for _, state in states) else 0
    except (Conflict, OSError, ValueError, KeyError) as error:
        print(f"Instruction bundle: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
