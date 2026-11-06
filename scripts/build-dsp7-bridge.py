#!/usr/bin/env python3
"""Rebuild public seat installer artifacts from the explicit installer allowlist."""
from pathlib import Path
import ast
import hashlib
import io
import json
import os
import zipfile

root = Path(__file__).resolve().parents[1]
source = Path(os.environ.get('DSP7_BRIDGE_SOURCE') or root / 'integrations' / 'dsp7-bridge').resolve()
installer = source / 'quick_install.py'
module = ast.parse(installer.read_text(encoding='utf-8'))
files = next(ast.literal_eval(node.value) for node in module.body
             if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'FILES' for target in node.targets))
archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
    for name in sorted(files):
        path = source / name
        if path.parent != source or path.is_symlink() or not path.is_file():
            raise ValueError('Invalid bridge bundle source: ' + name)
        entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.create_system = 3
        entry.external_attr = (0o100700 if name == 'claude-interactive-wrapper' else 0o100600) << 16
        bundle.writestr(entry, path.read_bytes())
payload = archive.getvalue()
public = root / 'ui' / 'public'
(public / 'dsp7-install.py').write_bytes(installer.read_bytes())
(public / 'dsp7-install.ps1').write_bytes((source / 'install_windows.ps1').read_bytes())
(public / 'dsp7-bridge.zip').write_bytes(payload)
digest = hashlib.sha256(payload).hexdigest()
(public / 'dsp7-bridge-manifest.json').write_text(json.dumps({'sha256': digest, 'format': 1, 'autoUpgrade': {'enabled': False, 'targetSha256': digest}}) + '\n', encoding='utf-8')
print(f'Built {len(files)} bridge files ({len(payload)} bytes); installed clients were not changed.')
