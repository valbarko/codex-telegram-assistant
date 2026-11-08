#!/usr/bin/env python3
"""Hold a kernel lock across exec so launchd/manual starts cannot race."""
import fcntl
import os
from pathlib import Path
import sys

root, node, tsx, source = sys.argv[1:]
lock = open(Path(root) / 'source.lock', 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(0)
os.set_inheritable(lock.fileno(), True)
os.execv(node, [node, tsx, source, root])
