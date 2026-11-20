#!/usr/bin/env python3
"""Put the OpenSubtitles API key into www/app.js at build time.

The key lives in the repository secret OPENSUBTITLES_API_KEY, never in the
source, so it stays out of this public repo. It ends up only inside the APK.
Run from the repository root:  OS_KEY=... python3 scripts/inject_key.py
"""
import os
import pathlib
import sys

PLACEHOLDER = '__OPENSUBTITLES_API_KEY__'
app = pathlib.Path('www/app.js')

if not app.exists():
    sys.exit('www/app.js not found — run this from the repository root.')

src = app.read_text(encoding='utf-8')
if PLACEHOLDER not in src:
    sys.exit('Placeholder %s is not in www/app.js — nothing to inject.' % PLACEHOLDER)

key = os.environ.get('OS_KEY', '').strip()
if not key:
    print('No OPENSUBTITLES_API_KEY secret is set.')
    print('The APK will still build; online subtitle search will just be off.')
    sys.exit(0)

app.write_text(src.replace(PLACEHOLDER, key), encoding='utf-8')
print('Injected the OpenSubtitles API key (%d characters).' % len(key))
