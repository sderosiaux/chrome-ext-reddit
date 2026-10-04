import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey } from '../storage.js';

const thread = {
  id: 't3_abc', title: 'A question', author: 'op', text: 'The question', comments: [
    { id: 't1_def', parent: 't3_abc', author: 'alice', text: 'A reply', score: 1, permalink: 'https://www.reddit.com/comments/abc/_/def/' },
  ], coverage: { complete: true, loaded: 1, reported: 1, reason: '', source: 'json' },
};
const settings = { provider: 'openai', detail: 'short', language: 'fr', personalContext: '' };

test('vote fluctuations reuse notes while content, relationships and coverage invalidate them', async () => {
  const original = await cacheKey(thread, settings, 'summary');
  const voted = structuredClone(thread); voted.comments[0].score = 2;
  assert.equal(await cacheKey(voted, settings, 'summary'), original);
  const retried = structuredClone(thread);
  Object.assign(retried.coverage, { requests: 12, actions: 84, fetchedPages: 55, exhausted: true, unresolved: 0 });
  assert.equal(await cacheKey(retried, settings, 'summary'), original);
  for (const field of ['text', 'parent', 'author', 'permalink']) {
    const changed = structuredClone(thread); changed.comments[0][field] += 'changed';
    assert.notEqual(await cacheKey(changed, settings, 'summary'), original, field);
  }
  const partial = structuredClone(thread); partial.coverage.complete = false;
  assert.notEqual(await cacheKey(partial, settings, 'summary'), original);
  assert.notEqual(await cacheKey(thread, { ...settings, detail: 'deep' }, 'summary'), original);
  assert.notEqual(await cacheKey(thread, settings, 'qa'), original);
});
