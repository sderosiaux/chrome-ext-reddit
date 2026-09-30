import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fetchThread, cleanHtml, processThreadData, partitionThread, threadUrl } from '../data.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const root = (count = 0) => ({ id: 'post1', name: 't3_post1', title: 'Can we disagree?', author: 'op', selftext: 'Post body', is_self: true, subreddit: 'test', num_comments: count, permalink: '/r/test/comments/post1/topic/' });
const comment = (id, parent = 't3_post1', body = 'Yes.', replies = []) => ({ kind: 't1', data: {
  id, name: `t1_${id}`, parent_id: parent, link_id: 't3_post1', author: 'reader', body,
  replies: replies.length ? { data: { children: replies } } : '',
} });
const more = (children, parent = 't3_post1') => ({ kind: 'more', data: { children, parent_id: parent, count: children.length } });
const listing = (things, count = 0) => [{ data: { children: [{ kind: 't3', data: root(count) }] } }, { data: { children: things } }];
const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('preserves fullnames, deleted parent nodes, short replies and safe sources', () => {
  const thread = processThreadData(root(3), [
    comment('a', 't3_post1', '[deleted]').data,
    { ...comment('b', 't1_a', 'No.').data, body_html: '<div class="md"><p>No. <a href="https://example.com">Evidence</a><script>bad()</script></p></div>' },
    { ...comment('c').data, author: '[deleted]' },
  ]);
  assert.equal(thread.comments[0].unavailable, true);
  assert.equal(thread.comments[1].parent, 't1_a');
  assert.equal(thread.comments[1].links[0].url, 'https://example.com/');
  assert.equal(thread.comments[2].text, 'Yes.');
  assert.equal(thread.comments[2].author, '');
  assert.equal(thread.url, null);
  assert.equal(threadUrl('t1_b', thread.id), 'https://www.reddit.com/comments/post1/_/b/');
  assert.equal(cleanHtml('&lt;div class="md"&gt;&lt;p&gt;A &amp;amp; B&lt;/p&gt;&lt;/div&gt;').text, 'A & B');
});

test('expands over 100 more IDs sequentially, deduplicates and retains the graph', async (t) => {
  const ids = Array.from({ length: 205 }, (_, i) => `c${i}`);
  let active = 0, peak = 0;
  const batchSizes = [];
  t.mock.method(globalThis, 'fetch', async (href) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    const url = new URL(href);
    let payload;
    if (url.pathname.endsWith('/morechildren.json')) {
      const children = url.searchParams.get('children').split(','); batchSizes.push(children.length);
      payload = { json: { errors: [], data: { things: children.map((id) => comment(id, 't1_first')) } } };
    } else payload = listing([comment('first', 't3_post1', 'A useful parent.'), more(ids)], 206);
    active--; return response(payload);
  });
  const thread = await fetchThread('post1');
  assert.deepEqual(batchSizes, [100, 100, 5]);
  assert.equal(peak, 1);
  assert.equal(thread.comments.length, 206);
  assert.equal(thread.comments[1].parent, 't1_first');
  assert.equal(thread.coverage.complete, true);
});

test('expands deep continue-thread stubs once and preserves full ancestry', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (href) => {
    calls++;
    if (new URL(href).searchParams.has('comment')) return response(listing([comment('a', 't3_post1', 'Parent', [comment('b', 't1_a')])], 2));
    return response(listing([comment('a', 't3_post1', 'Parent', [more([], 't1_a')])], 2));
  });
  const thread = await fetchThread('t3_post1');
  assert.equal(calls, 2);
  assert.equal(thread.comments[1].parent, 't1_a');
  assert.equal(thread.coverage.complete, true);
});

test('never claims completeness when Reddit omits a requested comment', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => response(++calls === 1
    ? listing([comment('a'), more(['missing'])], 1)
    : { json: { errors: [], data: { things: [] } } }));
  const thread = await fetchThread('post1');
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.coverage.complete, false);
  assert.match(thread.coverage.reason, /pas accessibles/);
});

test('uses the exact page snapshot on API block and marks it partial', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  const page = processThreadData(root(8), [comment('visible').data]);
  const thread = await fetchThread('post1', { getSnapshot: async () => page });
  assert.equal(thread.coverage.source, 'page');
  assert.equal(thread.coverage.complete, false);
  assert.equal(thread.coverage.loaded, 1);
  assert.match(thread.coverage.reason, /collecte automatique/);
  assert.doesNotMatch(thread.coverage.reason, /Déplie|HTTP 403/);
  await assert.rejects(fetchThread('post1', { getSnapshot: async () => ({ ...page, id: 't3_other' }) }), /chargement automatique/);
});

test('keeps API comments when a later expansion fails, merging page-only comments', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? response(listing([comment('api'), more(['other'])], 4))
    : new Response('', { status: 403 }));
  const thread = await fetchThread('post1', { getSnapshot: async () => processThreadData(root(4), [comment('page').data]) });
  assert.deepEqual(thread.comments.map((c) => c.id), ['t1_api', 't1_page']);
  assert.equal(thread.coverage.loaded, 2);
  assert.equal(thread.coverage.complete, false);
});

test('merges page-only comments when API coverage is incomplete without an HTTP error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(listing([comment('api')], 4)));
  const thread = await fetchThread('post1', { getSnapshot: async () => processThreadData(root(4), [comment('page').data]) });
  assert.deepEqual(thread.comments.map((c) => c.id), ['t1_api', 't1_page']);
  assert.equal(thread.coverage.loaded, 2);
  assert.equal(thread.coverage.complete, false);
});

test('handles Retry-After cooldowns without an unbounded wait', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); });
  const thread = await fetchThread('post1', { getSnapshot: async () => processThreadData(root()) });
  assert.equal(calls, 1);
  assert.match(thread.coverage.reason, /429/);
});

test('aborting does not silently return a page snapshot', async (t) => {
  const controller = new AbortController(); let snapshots = 0;
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(); throw controller.signal.reason; });
  await assert.rejects(fetchThread('post1', { signal: controller.signal, getSnapshot: () => { snapshots++; } }), { name: 'AbortError' });
  assert.equal(snapshots, 0);
});

test('partitioning preserves long text, short replies and title-only posts', () => {
  const thread = processThreadData({ ...root(2), selftext: '' }, [comment('a', 't3_post1', 'x'.repeat(8000)).data, comment('b', 't1_a', 'No.').data]);
  const records = partitionThread(thread, 4000).flatMap((chunk) => chunk.comments);
  assert.match(records.find((record) => record.id === thread.id).text, /Can we disagree/);
  assert.equal(records.filter((record) => record.id === 't1_a').map((record) => record.text).join(''), 'x'.repeat(8000));
  assert.equal(records.find((record) => record.id === 't1_b').text, 'No.');
});

test('UTF-8 partitions preserve mixed emoji/CJK text and fit the complete JSON byte budget', () => {
  const text = '中文🙂🚀 é café "quoted" \\ path\n\t'.repeat(350);
  const title = '讨论：为什么？🧭';
  const thread = processThreadData({ ...root(3), title, selftext: '引言🌍'.repeat(400) }, [
    comment('a', 't3_post1', text).data,
    comment('b', 't1_a', '反对🛑'.repeat(180)).data,
    comment('c', 't1_b', 'No.').data,
  ]);
  const budget = 2400;
  const chunks = partitionThread(thread, budget);
  const records = chunks.flatMap((chunk) => chunk.comments);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(JSON.stringify(chunk), 'utf8') <= budget);
  for (const node of [thread, ...thread.comments]) {
    const recovered = records.filter((record) => record.id === node.id).map((record) => record.text).join('');
    assert.equal(recovered, node.id === thread.id ? `${title}\n\n${thread.text}` : node.text);
  }
  for (const record of records) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(record.text), 'no dangling high surrogate');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(record.text), 'no dangling low surrogate');
  }
});

test('uses the same-origin page transport for the thread and every morechildren batch', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Extension-origin fetch must not run'); });
  const requests = [];
  const thread = await fetchThread('post1', { requestJson: async request => {
    requests.push(request);
    return { ok: true, data: request.kind === 'thread' ? listing([comment('first'), more(['second'])], 2)
      : { json: { errors: [], data: { things: [comment('second', 't1_first')] } } } };
  } });
  assert.deepEqual(requests, [{ kind: 'thread' }, { kind: 'more', children: ['second'] }]);
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.coverage.complete, true);
});

test('automatically collects unloaded page replies after API denial instead of requesting manual expansion', async () => {
  let collected = 0, snapshots = 0;
  const page = processThreadData(root(2), [comment('first').data, comment('second', 't1_first').data], { source: 'page-auto', complete: true });
  const thread = await fetchThread('post1', {
    requestJson: async () => ({ ok: false, status: 403 }),
    collectComments: async () => { collected++; return page; },
    getSnapshot: async () => { snapshots++; throw new Error('Manual fallback should not run'); },
  });
  assert.equal(collected, 1);
  assert.equal(snapshots, 0);
  assert.equal(thread.coverage.complete, true);
  assert.equal(thread.coverage.loaded, 2);
  assert.equal(thread.coverage.reason, '');
});

test('automatic DOM collection merges API comments without hiding a remaining Reddit count gap', async () => {
  const page = processThreadData(root(4), [comment('second').data], { source: 'page-auto', complete: false, reason: 'Certaines réponses restent inaccessibles.' });
  const thread = await fetchThread('post1', {
    requestJson: async () => ({ ok: true, data: listing([comment('first')], 4) }),
    collectComments: async () => page,
  });
  assert.deepEqual(thread.comments.map(c => c.id), ['t1_first', 't1_second']);
  assert.equal(thread.coverage.complete, false);
  assert.match(thread.coverage.reason, /2 commentaires.*après la collecte automatique/);
});


test('cyclic API ancestry remains available but cannot be declared complete', async () => {
  let collections = 0;
  const thread = await fetchThread('post1', {
    requestJson: async () => ({ ok: true, data: listing([comment('a', 't1_b'), comment('b', 't1_a')], 2) }),
    collectComments: async () => { collections++; return null; },
  });
  assert.equal(collections, 1);
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.coverage.complete, false);
});

test('automatic page coverage cannot override cyclic ancestry after API merge', async () => {
  const page = processThreadData(root(2), [comment('a').data, comment('b', 't1_a').data], { source: 'page-auto', complete: true });
  const thread = await fetchThread('post1', {
    requestJson: async () => ({ ok: true, data: listing([comment('a', 't1_b')], 2) }),
    collectComments: async () => page,
  });
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.coverage.complete, false);
});

test('page-only complete claims require every ancestor chain to reach the requested post', async () => {
  for (const records of [[comment('a', 't1_a').data], [comment('a', 't1_missing').data]]) {
    const page = processThreadData(root(1), records, { source: 'page-auto', complete: true });
    const thread = await fetchThread('post1', {
      requestJson: async () => ({ ok: false, status: 403 }),
      collectComments: async () => page,
    });
    assert.equal(thread.comments.length, 1);
    assert.equal(thread.coverage.complete, false);
  }
});
