import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// One allowlist-based builder for CLI and normal UI releases.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const result=spawnSync('python3',[path.join(root,'scripts/build-dsp7-bridge.py')],{stdio:'inherit',env:process.env});
if(result.status!==0)process.exit(result.status||1);
