import { readFile, readdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['activeTab', 'storage']);
assert(!JSON.stringify(manifest).includes('<all_urls>'));
const files = [manifest.background.service_worker, ...manifest.content_scripts.flatMap(s => [...s.js, ...s.css]),
  ...manifest.web_accessible_resources.flatMap(r => r.resources)];
await Promise.all(files.map(file => access(file)));
for (const file of await readdir('.')) {
  if (!file.endsWith('.js')) continue;
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"]\.\/(.*?)['"]/g)) await access(match[1]);
  assert(!/news\.ycombinator\.com|hacker-news\.firebaseio|hn\.algolia/.test(source), `${file}: old HN endpoint`);
}
console.log('Manifest, permissions, extension resources, imports and JavaScript syntax: OK');
