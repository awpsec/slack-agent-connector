import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]); }
for (const file of ['src','public','bin','scripts','test','extensions'].flatMap(walk).filter(f => /\.(mjs|js)$/.test(f))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('JavaScript syntax checks passed.');
