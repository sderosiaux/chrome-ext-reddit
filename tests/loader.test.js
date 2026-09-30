import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const scripts = ['reddit-dom.js', 'reddit-loader.js'].map((name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const href = 'https://www.reddit.com/r/test/comments/post1/example/';
const post = (count) => `<shreddit-post post-id="t3_post1" post-title="Example" comment-count="${count}"><div slot="text-body">Question</div></shreddit-post>`;
const comment = (id, parent = 't3_post1', body = id) => `<shreddit-comment thingid="t1_${id}" parentid="${parent}"><div slot="comment">${body}</div></shreddit-comment>`;
const partial = (id = 'one') => `<faceplate-partial id="${id}" src="/svc/shreddit/more-comments/r/test/t3_post1?offset=${id}" loading="action" method="post"><input name="cursor" value="cursor-${id}"><button type="button">More replies</button><button slot="loading" aria-label="Loading">Wait</button></faceplate-partial>`;
function fixture(html, url = href) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const now = Date.now;
  const start = now();
  window.Date.now = () => start + (now() - start) * 100;
  const timer = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => timer(fn, Math.max(1, ms / 100), ...args);
  window.scrollTo = () => {};
  for (const script of scripts) window.eval(script);
  return { dom, window, doc: window.document, collect: (opts) => window.RedditDistillLoader.collect({ threadId: 't3_post1', ...opts }) };
}
const plain = (result) => JSON.parse(JSON.stringify(result));

test('native modern loaders discover nested replies and preserve comments removed by virtualization', async () => {
  const { window, doc, collect } = fixture(`${post(3)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}${partial()}</shreddit-comment-tree>`);
  const updates = [];
  doc.querySelector('#one button').addEventListener('click', () => {
    doc.querySelector('shreddit-comment').remove();
    doc.querySelector('#one').outerHTML = `${comment('b', 't1_a')}${partial('two')}`;
    doc.querySelector('#two button').addEventListener('click', () => { doc.querySelector('#two').outerHTML = comment('c', 't1_b'); });
  });
  const result = plain(await collect({ onProgress: (event) => updates.push(plain(event)) }));
  assert.deepEqual(result.comments.map(({ id, parent }) => [id, parent]), [['t1_a', 't3_post1'], ['t1_b', 't1_a'], ['t1_c', 't1_b']]);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.source, 'page-auto');
  assert.equal(result.coverage.loaded, 3);
  assert.ok(updates.some((event) => event.loaded === 3 && event.actions === 2));
  window.close();
});

test('old Reddit expands collapsed comments and loads morechildren without following navigation links', async () => {
  const { window, doc, collect } = fixture(`<div class="thing link" data-fullname="t3_post1" data-comments-count="2"><a class="title">Old thread</a></div>
    <div class="commentarea"><div class="thing comment collapsed" data-fullname="t1_a"><a class="expand" href="#">[+]</a><div class="usertext-body"><div class="md">Parent</div></div></div>
    <div class="morechildren"><a href="javascript:void(0)">load more comments</a></div></div>`, href.replace('www.', 'old.'));
  let expanded = false;
  doc.querySelector('a.expand').addEventListener('click', (event) => { event.preventDefault(); expanded = true; doc.querySelector('.collapsed').classList.remove('collapsed'); });
  doc.querySelector('.morechildren a').addEventListener('click', () => { doc.querySelector('.morechildren').outerHTML = '<div class="thing comment" data-fullname="t1_b" data-parent-fullname="t1_a"><div class="usertext-body"><div class="md">Reply</div></div></div>'; });
  const result = plain(await collect());
  assert.equal(expanded, true);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.comments[1].parent, 't1_a');
  assert.equal(window.location.href, href.replace('www.', 'old.'));
  window.close();
});

test('deep continuation pages are fetched recursively, merged and deduplicated without navigating', async () => {
  const link = (id) => `<a slot="more-comments-permalink" href="/r/test/comments/post1/comment/${id}/?force-legacy-sct=1">Continue this thread</a>`;
  const { window, collect } = fixture(`${post(3)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}${link('a')}</shreddit-comment-tree>`);
  const calls = [];
  window.fetch = async (url, options) => {
    calls.push([url, options]);
    return { ok: true, url, text: async () => url.includes('/comment/a/')
      ? `${post(3)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}${comment('b', 't1_a')}${link('b')}</shreddit-comment-tree>`
      : `${comment('b', 't3_post1')}${comment('c', 't1_b')}${link('a')}` };
  };
  const result = plain(await collect());
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.comments.map(({ id, parent }) => [id, parent]), [['t1_a', 't3_post1'], ['t1_b', 't1_a'], ['t1_c', 't1_b']]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].credentials, 'include');
  assert.equal(calls[0][1].redirect, 'follow');
  assert.equal(calls[0][1].mode, 'same-origin');
  assert.equal(window.location.href, href);
  window.close();
});

test('does not click votes, replies, login, unrelated links or stale SPA controls', async () => {
  const { window, doc, collect } = fixture(`${post(1)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}
    <button>Upvote</button><button>Reply</button><button>Report</button><button>Log in</button><button>Join</button>
    <a role="button" href="/login">Load more comments</a>
    <a slot="more-comments-permalink" href="https://attacker.example/comments/post1/">Continue this thread</a>
    <a slot="more-comments-permalink" href="/r/test/comments/other/comment/a/">Continue this thread</a>
    </shreddit-comment-tree><shreddit-comment-tree post-id="t3_old">${comment('old', 't3_old')}${partial('old')}</shreddit-comment-tree>`);
  let clicks = 0;
  doc.addEventListener('click', () => clicks++);
  window.fetch = () => { throw new Error('Must not fetch'); };
  const result = plain(await collect());
  assert.equal(result.coverage.complete, true);
  assert.equal(clicks, 0);
  window.close();
});

test('native lazy top-level loader is revealed and previous scroll position restored', async () => {
  const { window, doc, collect } = fixture(`${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}<faceplate-partial id="top-level-more-comments-partial" loading="lazy" method="post" src="/svc/shreddit/more-comments/r/test/t3_post1?top-level=1"></faceplate-partial></shreddit-comment-tree>`);
  let revealed = 0, restored = 0;
  window.scrollTo = () => restored++;
  doc.querySelector('faceplate-partial').scrollIntoView = () => { revealed++; doc.querySelector('faceplate-partial').outerHTML = comment('b'); };
  const result = plain(await collect());
  assert.equal(result.coverage.complete, true);
  assert.equal(revealed, 1);
  assert.equal(restored, 1);
  window.close();
});

test('open shadow-root comment disclosure controls are expanded safely', async () => {
  const { window, doc, collect } = fixture(`${post(1)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}</shreddit-comment-tree>`);
  const root = doc.querySelector('shreddit-comment').attachShadow({ mode: 'open' });
  root.innerHTML = '<button aria-label="Expand comment">+</button><button aria-label="Reply">Reply</button>';
  let expanded = 0;
  root.querySelector('button').addEventListener('click', () => { expanded++; root.querySelector('button').setAttribute('aria-label', 'Collapse comment'); });
  const result = plain(await collect());
  assert.equal(result.coverage.complete, true);
  assert.equal(expanded, 1);
  window.close();
});

test('a stuck native control is retried finitely and cannot claim complete coverage', async () => {
  const { window, doc, collect } = fixture(`${post(1)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}${partial()}</shreddit-comment-tree>`);
  let clicks = 0;
  doc.querySelector('#one button').addEventListener('click', () => clicks++);
  const result = plain(await collect());
  assert.equal(clicks, 2);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /tentatives automatiques/);
  assert.doesNotMatch(result.coverage.reason, /Déplie/);
  window.close();
});

test('failed continuation fetches are retried finitely and retain collected comments', async () => {
  const { window, collect } = fixture(`${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}<a slot="more-comments-permalink" href="/r/test/comments/post1/comment/a/">Continue this thread</a></shreddit-comment-tree>`);
  let calls = 0;
  window.fetch = async () => { calls++; return { ok: false, status: 403 }; };
  const result = plain(await collect());
  assert.equal(calls, 2);
  assert.equal(result.comments.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /1 commentaires récupérés sur 2/);
  window.close();
});

test('aborting collection stops retries immediately', async () => {
  const { window, doc, collect } = fixture(`${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}${partial()}</shreddit-comment-tree>`);
  const controller = new window.AbortController();
  let clicks = 0;
  doc.querySelector('#one button').addEventListener('click', () => { clicks++; controller.abort(); });
  await assert.rejects(collect({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(clicks, 1);
  window.close();
});

test('SPA navigation to a different thread cancels collection before further actions', async () => {
  const { window, doc, collect } = fixture(`${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}${partial()}</shreddit-comment-tree>`);
  doc.querySelector('#one button').addEventListener('click', () => window.history.replaceState({}, '', '/r/test/comments/other/new/'));
  await assert.rejects(collect(), { name: 'AbortError' });
  window.close();
});

test('unknown or unreachable totals stay honest after automatic exploration', async () => {
  for (const count of ['', '5']) {
    const { window, collect } = fixture(`${post(count)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}</shreddit-comment-tree>`);
    const result = plain(await collect());
    assert.equal(result.coverage.complete, false);
    assert.match(result.coverage.reason, /explorées automatiquement/);
    window.close();
  }
});


test('a complete count with missing parent comments cannot claim full coverage', async () => {
  const { window, collect } = fixture(`${post(1)}<shreddit-comment-tree post-id="t3_post1">${comment('b', 't1_missing')}</shreddit-comment-tree>`);
  const result = plain(await collect());
  assert.equal(result.comments.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /commentaires parents/);
  window.close();
});


test('a cyclic comment graph is never declared complete', async () => {
  const { window, collect } = fixture(`${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('a', 't1_b')}${comment('b', 't1_a')}</shreddit-comment-tree>`);
  const result = plain(await collect());
  assert.equal(result.comments.length, 2);
  assert.equal(result.coverage.complete, false);
  window.close();
});


test('native-only loaders in detached continuation HTML prevent false complete coverage', async () => {
  const { window, collect } = fixture(`${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}<a slot="more-comments-permalink" href="/r/test/comments/post1/comment/a/">Continue this thread</a></shreddit-comment-tree>`);
  window.fetch = async (url) => ({ ok: true, url, text: async () => `${post(2)}<shreddit-comment-tree post-id="t3_post1">${comment('b', 't1_a')}${partial('detached')}</shreddit-comment-tree>` });
  const result = plain(await collect());
  assert.equal(result.coverage.loaded, 2);
  assert.equal(result.coverage.reported, 2);
  assert.equal(result.coverage.complete, false);
  assert.match(result.coverage.reason, /chargements/);
  window.close();
});


test('an already-loading partial without a clickable button cannot prove exhaustion', async () => {
  const { window, collect } = fixture(`${post(1)}<shreddit-comment-tree post-id="t3_post1">${comment('a')}<faceplate-partial loading="action" src="/svc/shreddit/more-comments/r/test/t3_post1"><button slot="loading" aria-label="Loading">Wait</button></faceplate-partial></shreddit-comment-tree>`);
  const result = plain(await collect());
  assert.equal(result.coverage.loaded, 1);
  assert.equal(result.coverage.complete, false);
  window.close();
});
