import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRecoveryBundle, verifyRecoveryBundle, restoreRecoveryBundle } from './instance-recovery-bundle.mjs';

test('complete bundle round-trip preserves dump, artifacts, config, logs and key; rejects corruption and overwrites', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-recovery-'));
  try {
    const components = {};
    for (const key of ['database', 'config', 'masterKey']) { const file = path.join(root, key); await fs.writeFile(file, key === 'masterKey' ? Buffer.from([1, 2, 3, 255]) : key + ' fixture'); components[key] = file; }
    for (const key of ['artifacts', 'runLogs']) { const dir = path.join(root, key); await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'evidence.txt'), key + ' evidence'); components[key] = dir; }
    const bundle = path.join(root, 'bundle'), restored = path.join(root, 'restored');
    await assert.rejects(createRecoveryBundle({ components, destination: bundle }), /quiesced/);
    await createRecoveryBundle({ components, destination: bundle, quiesced: true });
    await verifyRecoveryBundle(bundle); await restoreRecoveryBundle(bundle, restored);
    assert.deepEqual(await fs.readFile(path.join(restored, 'masterKey')), await fs.readFile(components.masterKey));
    assert.equal(await fs.readFile(path.join(restored, 'artifacts/evidence.txt'), 'utf8'), 'artifacts evidence');
    assert.equal((await fs.stat(path.join(bundle, 'masterKey'))).mode & 0o777, 0o600);
    await assert.rejects(restoreRecoveryBundle(bundle, restored), /already exists/);
    await assert.rejects(restoreRecoveryBundle(bundle, path.join(bundle, 'nested')), /outside/);
    await fs.writeFile(path.join(bundle, 'artifacts/evidence.txt'), 'corrupted');
    await assert.rejects(verifyRecoveryBundle(bundle), /Checksum/);
    await assert.rejects(restoreRecoveryBundle(bundle, path.join(root, 'corrupt-restore')), /Checksum/);
    await assert.rejects(fs.stat(path.join(root, 'corrupt-restore')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('rejects source escapes and removes partial bundles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-recovery-links-'));
  try {
    const file = path.join(root, 'file'), artifacts = path.join(root, 'artifacts'); await fs.writeFile(file, 'fixture'); await fs.mkdir(artifacts);
    const components = { database: file, config: file, masterKey: file, artifacts, runLogs: artifacts };
    await assert.rejects(createRecoveryBundle({ components, destination: path.join(artifacts, 'bundle'), quiesced: true }), /outside/);
    await fs.symlink(file, path.join(artifacts, 'escaped'));
    await assert.rejects(createRecoveryBundle({ components, destination: path.join(root, 'bundle'), quiesced: true }), /links/);
    assert.deepEqual((await fs.readdir(root)).sort(), ['artifacts', 'file']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
