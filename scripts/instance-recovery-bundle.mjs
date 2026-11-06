import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

const required = ['database', 'config', 'masterKey', 'artifacts', 'runLogs'];
async function hash(file) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest('hex');
}
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.isAbsolute(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
async function inventory(root, relative = '') {
  const absolute = path.join(root, relative), stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Recovery bundles require regular files and directories; links are rejected');
  if (stat.isFile()) return [{ path: relative, size: stat.size, sha256: await hash(absolute) }];
  const entries = [];
  for (const name of (await fs.readdir(absolute)).sort()) entries.push(...await inventory(root, relative ? `${relative}/${name}` : name));
  return entries;
}
async function absent(destination) {
  try { await fs.lstat(destination); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Destination already exists; recovery never overwrites existing data');
}

/** The caller must quiesce application writers and create a logical database dump first. */
export async function createRecoveryBundle({ components, destination, quiesced }) {
  if (quiesced !== true) throw new Error('Stop application writers and acknowledge quiesced=true before bundling');
  if (!components || required.some(key => typeof components[key] !== 'string')) throw new Error('Provide database, config, masterKey, artifacts and runLogs paths');
  if (Object.keys(components).some(key => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key))) throw new Error('Invalid component name');
  destination = path.join(await fs.realpath(path.dirname(path.resolve(destination))), path.basename(destination)); await absent(destination);
  const sources = Object.fromEntries(await Promise.all(Object.entries(components).map(async ([key, value]) => [key, await fs.realpath(value)])));
  for (const source of Object.values(sources)) {
    const relative = path.relative(source, destination);
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Bundle destination must be outside all source paths');
  }
  for (const key of ['database', 'config', 'masterKey']) if (!(await fs.stat(sources[key])).isFile()) throw new Error(`${key} must be a file`);
  const stage = destination + '.partial-' + randomUUID();
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const manifest = { version: 1, createdAt: new Date().toISOString(), consistency: 'operator-quiesced', components: {} };
    for (const [key, source] of Object.entries(sources)) {
      // Read the original path too: reject a symlink supplied as a component root.
      if ((await fs.lstat(components[key])).isSymbolicLink()) throw new Error('Component roots cannot be symlinks');
      const before = await inventory(source), kind = (await fs.stat(source)).isFile() ? 'file' : 'directory';
      const location = key === 'database' ? (source.endsWith('.gz') ? 'database.sql.gz' : 'database.sql') : key;
      await fs.cp(source, path.join(stage, location), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      const after = await inventory(source), copied = await inventory(path.join(stage, location));
      if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(copied)) throw new Error('Source changed during backup; keep application writers stopped');
      manifest.components[key] = { kind, location, files: copied };
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    // The bundle contains encryption keys and config secrets. Restrict every copied file.
    async function restrict(dir) {
      for (const name of await fs.readdir(dir)) { const file = path.join(dir, name), stat = await fs.lstat(file); await fs.chmod(file, stat.isDirectory() ? 0o700 : 0o600); if (stat.isDirectory()) await restrict(file); }
    }
    await restrict(stage); await absent(destination); await fs.rename(stage, destination);
    return manifest;
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}

export async function verifyRecoveryBundle(bundle) {
  const rootStat = await fs.lstat(bundle);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid bundle directory');
  const manifestPath = path.join(bundle, 'manifest.json');
  if (!(await fs.lstat(manifestPath)).isFile() || (await fs.lstat(manifestPath)).isSymbolicLink()) throw new Error('Invalid manifest');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !manifest.components || required.some(key => !manifest.components[key])) throw new Error('Unsupported or incomplete recovery manifest');
  const names = Object.keys(manifest.components);
  if (names.some(key => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key))) throw new Error('Invalid component name');
  const actualNames = (await fs.readdir(bundle)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...Object.entries(manifest.components).map(([key, value]) => value.location ?? key), 'manifest.json'].sort())) throw new Error('Unexpected or missing bundle files');
  for (const [key, value] of Object.entries(manifest.components)) {
    if (!['file', 'directory'].includes(value.kind) || !Array.isArray(value.files) || value.files.some(file => value.kind === 'file' ? file.path !== '' : !safeRelative(file.path))) throw new Error('Invalid manifest paths');
    const location = value.location ?? key;
    if (key === 'database' ? !['database.sql', 'database.sql.gz'].includes(location) : location !== key) throw new Error('Invalid component location');
    const component = path.join(bundle, location), stat = await fs.lstat(component);
    if ((value.kind === 'file') !== stat.isFile()) throw new Error('Component kind mismatch');
    if (JSON.stringify(await inventory(component)) !== JSON.stringify(value.files)) throw new Error(`Checksum mismatch in ${key}`);
  }
  return manifest;
}

/** Restores files to a NEW staging directory. Database import remains an explicit isolated step. */
export async function restoreRecoveryBundle(bundle, destination) {
  destination = path.join(await fs.realpath(path.dirname(path.resolve(destination))), path.basename(destination));
  const relative = path.relative(await fs.realpath(bundle), destination);
  if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Restore destination must be outside the bundle");
  await verifyRecoveryBundle(bundle); await absent(destination);
  const stage = path.resolve(destination) + '.partial-' + randomUUID();
  try {
    await fs.cp(bundle, stage, { recursive: true, force: false, errorOnExist: true });
    await verifyRecoveryBundle(stage); await absent(destination); await fs.rename(stage, destination);
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, source, destination] = process.argv.slice(2);
  try {
    if (command === 'create') await createRecoveryBundle({ ...JSON.parse(await fs.readFile(source, 'utf8')), destination });
    else if (command === 'verify') await verifyRecoveryBundle(source);
    else if (command === 'restore') await restoreRecoveryBundle(source, destination);
    else throw new Error('Usage: node scripts/instance-recovery-bundle.mjs create spec.json new-dir | verify bundle-dir | restore bundle-dir new-dir');
    console.log('Recovery bundle ' + command + ' completed');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
