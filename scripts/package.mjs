import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const files = [...new Set(['manifest.json', 'README.md', manifest.background.service_worker,
  ...manifest.content_scripts.flatMap(s => [...s.js, ...s.css]),
  ...manifest.web_accessible_resources.flatMap(r => r.resources)])].sort();
await mkdir('dist', { recursive: true });
const target = `dist/reddit-distill-${manifest.version}.zip`;
await rm(target, { force: true });
execFileSync('zip', ['-q', '-X', target, ...files]);
console.log(target);
