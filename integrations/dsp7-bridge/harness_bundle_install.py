"""Versioned local composition installation; native config and idle locks retained."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from harness_bundle import validate
from pilot import BridgeError, atomic_json, read_json
from platform_support import private_directory
from seat_upgrade import acquire_upgrade_lock, assert_idle


def plan(b, source, expected_digest, project, seat_id):
    if seat_id != b.cfg['agent_id']:
        raise BridgeError('安装命令属于其他席位')
    checked = validate(dict(enabled=True, bundleRoot=str(Path(source)), bundleDigest=expected_digest, project=project), (b.root,))
    return dict(schema='harness.bundle-install/1', stage='planned', bundleDigest=expected_digest,
        project=project, seatId=seat_id, expectedConfigDigest=hashlib.sha256(b.config_path.read_bytes()).hexdigest(),
        packages=checked['catalog']['packages'], activation='per-native-run-route', executionGranted=False)


def install(b, source, expected_digest, project, seat_id, expected_config_digest):
    proposed = plan(b, source, expected_digest, project, seat_id)
    if proposed['expectedConfigDigest'] != expected_config_digest:
        raise BridgeError('安装配置版本已变化，请重新生成安装计划')
    runtime = Path(b.cfg['database']).parent
    interactive = private_directory(runtime/'interactive')
    with contextlib.ExitStack() as stack:
        for path in (runtime/'upgrade.lock', interactive/'operator.lock', runtime/'config.lock'):
            acquire_upgrade_lock(stack.enter_context(path.open('a')))
        raw = b.config_path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected_config_digest:
            raise BridgeError('安装配置版本已变化，请重新生成安装计划')
        b.cfg = json.loads(raw)
        if b.cfg['agent_id'] != seat_id:
            raise BridgeError('原席位身份已变化')
        assert_idle(b)
        prior_versions = b.cfg.get('harness_v2_execution', {}).get('versions', {})
        if expected_digest not in prior_versions and len(prior_versions) >= 16:
            raise BridgeError('本机正式组合版本达到上限，请先核对保留中的运行版本')
        # Windows launchers and filesystem callers still encounter MAX_PATH.
        # Keep the private store short while retaining per-organization scope;
        # the complete content pin remains mandatory even for prefix collisions.
        if os.name == 'nt':
            scope = hashlib.sha256(str(runtime.resolve()).encode('utf8')).hexdigest()[:12]
            store = private_directory(private_directory(Path.home()/'.hvb')/scope)
            target = store/expected_digest[:16]
        else:
            store = private_directory(runtime/'harness-bundles')
            target = store/expected_digest
        config = dict(enabled=True, bundleRoot=str(target), bundleDigest=expected_digest, project=project)
        if target.exists() or target.is_symlink():
            validate(config, (b.root,))  # existing versions are never overwritten
        else:
            with tempfile.TemporaryDirectory(prefix='.install-', dir=store) as scratch:
                staging = Path(scratch)/'bundle'
                staging.mkdir()
                # Only the immutable package payload, not untrusted sidecars,
                # credentials, business state or source inventory, is copied.
                for layer in ('runtime', 'resources'):
                    shutil.copytree(Path(source)/layer, staging/layer, symlinks=True)
                shutil.copyfile(Path(source)/'bundle-lock.json', staging/'bundle-lock.json')
                validate(dict(config, bundleRoot=str(staging)), (b.root,))
                staging.rename(target)
        updated = dict(b.cfg.get('harness_v2_execution', {}))
        versions = dict(updated.get('versions', {}))
        versions[expected_digest] = config
        updated.update(enabled=True, versions=versions)
        result = dict(b.cfg, harness_v2_execution=updated)
        # The original organization config is the single pointer authority.
        # Failed config writes leave an unreferenced immutable version only.
        atomic_json(b.config_path, result)
        b.cfg = read_json(b.config_path)
        if b.cfg.get('harness_v2_execution') != updated:
            raise BridgeError('安装配置回读不一致')
        return dict(proposed, stage='installed', installed=True, hostLoadConfirmed=False,
                    registryRegistered=False, executionReady=False)
