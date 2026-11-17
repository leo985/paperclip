"""Bootstrap validation for an explicitly pinned, operator-reviewed bundle.

The lock hash is a local trust input, not a signature or platform authorization.
No package code runs until the lock, manifests and every declared file match it.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))+'\n').encode()


def sha(value):return hashlib.sha256(value).hexdigest()


def read(root, name):
    if not isinstance(name,str) or name.startswith('/') or '\\' in name or ':' in name or any(p in ('','.','..') for p in name.split('/')):
        raise ValueError('Unsafe bundle path')
    path=root/name
    if path.resolve()!=path or not path.is_file() or path.stat().st_size>4*1024*1024:
        raise ValueError('Unsafe bundle file')
    return path.read_bytes()


def validate(config, working_roots=()):
    if set(config)!={'enabled','bundleRoot','bundleDigest','project'} or config['enabled'] is not True:
        raise ValueError('Invalid bundle configuration')
    if not isinstance(config['bundleDigest'],str) or not re.fullmatch('[a-f0-9]{64}',config['bundleDigest']):
        raise ValueError('Invalid bundle pin')
    root=Path(config['bundleRoot'])
    if not root.is_absolute() or root.resolve()!=root:
        raise ValueError('Bundle requires canonical absolute path')
    lock=json.loads(read(root,'bundle-lock.json'))
    if sha(canonical(lock))!=config['bundleDigest'] or lock.get('schema')!='harness.bundle-lock/1':
        raise ValueError('Bundle lock mismatch')
    entries=lock.get('packages')
    if not isinstance(entries,list) or len(entries)!=2 or {p.get('path') for p in entries}!={'runtime','resources'}:
        raise ValueError('Invalid bundle layout')
    manifests={}
    for entry in entries:
        package=root/entry['path']
        raw=read(package,'manifest.json')
        if sha(raw)!=entry['manifestDigest']:raise ValueError('Bundle manifest mismatch')
        manifest=json.loads(raw)
        actual=set()
        for path in package.rglob('*'):
            if path.is_symlink():raise ValueError('Bundle symlink')
            if path.is_file():actual.add(path.relative_to(package).as_posix())
        if actual!=set(manifest['files'])|{'manifest.json'}:raise ValueError('Bundle file inventory mismatch')
        for name,digest in manifest['files'].items():
            if sha(read(package,name))!=digest:raise ValueError('Bundle file changed')
        manifests[entry['path']]=manifest
    # The verifier itself has now been checked against the configured trust pin.
    result=subprocess.run([sys.executable,'-I',str(root/'runtime/tools/packages.py'),'verify',str(root),
        '--project',config['project']],capture_output=True,text=True,timeout=5,check=True)
    catalog=json.loads(result.stdout)
    if catalog.get('bundleDigest')!=config['bundleDigest'] or catalog.get('verified') is not True:
        raise ValueError('Bundle verifier mismatch')
    # Claude discovers workspace skills at cwd and its ancestors. Never rename or
    # disable existing skills automatically. User/global plugin state is not probed.
    skill_roots=set()
    for location in working_roots:
        path=Path(location).resolve()
        skill_roots.update(parent/'.claude/skills' for parent in (path,*path.parents))
    for package in catalog['packages']:
        for skill in package['skills']:
            if any((p/skill/'SKILL.md').exists() for p in skill_roots):
                raise ValueError('Existing workspace skill conflicts with bundle')
    return dict(root=str(root),runtimeRoot=str(root/'runtime'),resourceRoot=str(root/'resources'),
        sourceDigest=next(e['manifestDigest'] for e in entries if e['path']=='runtime'),
        resourceDigest=next(e['manifestDigest'] for e in entries if e['path']=='resources'),catalog=catalog)
