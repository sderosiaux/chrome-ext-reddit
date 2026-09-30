import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const script = readFileSync(new URL('../reddit-dom.js', import.meta.url), 'utf8');
const href = 'https://www.reddit.com/r/test/comments/post1/example/';
function extract(html, url = href) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.eval(script);
  return JSON.parse(JSON.stringify(dom.window.RedditDistillDOM.extractThread(dom.window.document, url)));
}

test('modern Reddit extraction retains parent context without copying descendant text', () => {
  const thread = extract(`<shreddit-post post-id="t3_post1" post-title="Example" author="op" subreddit-prefixed-name="r/test" comment-count="15" content-href="${href}">
    <div slot="text-body"><p>Post text</p></div></shreddit-post>
    <shreddit-comment-tree><shreddit-comment thingid="t1_a" author="alice" parentid="t3_post1" depth="0">
      <div slot="comment"><p>Parent <a href="https://example.com">source</a></p></div>
      <shreddit-comment thingid="t1_b" author="bob" depth="1"><div slot="comment">No.</div></shreddit-comment>
    </shreddit-comment></shreddit-comment-tree>`);
  assert.equal(thread.id, 't3_post1');
  assert.equal(thread.text, 'Post text');
  assert.equal(thread.subreddit, 'test');
  assert.equal(thread.url, null);
  assert.equal(thread.comments[0].text, 'Parent source');
  assert.equal(thread.comments[1].parent, 't1_a');
  assert.equal(thread.comments[1].text, 'No.');
  assert.equal(thread.coverage.loaded, 2);
  assert.equal(thread.coverage.reported, 15);
  assert.equal(thread.coverage.complete, false);
});

test('old Reddit extraction preserves deleted ancestry, links and self-post text', () => {
  const thread = extract(`<div class="thing link" data-fullname="t3_post1" data-author="op" data-subreddit="test">
    <a class="title" href="${href}">Old thread</a><a class="comments" href="${href}">1,234 comments</a>
    <div class="usertext-body"><div class="md"><p>Post</p></div></div></div>
    <div class="commentarea"><div class="thing comment" data-fullname="t1_a" data-author="[deleted]">
      <div class="entry"><div class="usertext-body"><div class="md">[deleted]</div></div></div>
      <div class="child"><div class="thing comment" data-fullname="t1_b" data-author="reader">
        <div class="entry"><a class="bylink" href="/r/test/comments/post1/example/b/">permalink</a>
        <div class="usertext-body"><div class="md"><p>A reply</p><p><a href="javascript:alert(1)">Bad link</a></p></div></div></div>
      </div></div></div></div>`, href.replace('www.', 'old.'));
  assert.equal(thread.comments[0].unavailable, true);
  assert.equal(thread.comments[0].author, '');
  assert.equal(thread.comments[1].parent, 't1_a');
  assert.equal(thread.comments[1].links.length, 0);
  assert.equal(thread.coverage.reported, 1234);
  assert.equal(thread.comments[1].permalink, 'https://www.reddit.com/r/test/comments/post1/example/b/');
});

test('rejects a stale SPA post and does not read unrelated comments', () => {
  assert.throws(() => extract('<shreddit-post post-id="t3_another" post-title="Other"></shreddit-post>'), /pas encore chargé/);
  const thread = extract(`<shreddit-post post-id="t3_post1" post-title="Example"></shreddit-post>
    <shreddit-comment thingid="t1_a" parentid="t3_another"><div slot="comment">Unrelated</div></shreddit-comment>`);
  assert.equal(thread.comments.length, 0);
});

test('an exact visible count still cannot prove page completeness', () => {
  const thread = extract(`<shreddit-post post-id="t3_post1" post-title="Example" comment-count="1"></shreddit-post>
    <shreddit-comment thingid="t1_a" parentid="t3_post1"><div slot="comment">One</div></shreddit-comment>`);
  assert.equal(thread.coverage.loaded, thread.coverage.reported);
  assert.equal(thread.coverage.complete, false);
});

test('excludes an entire stale nested branch while selecting the current comment tree', () => {
  const thread = extract(`<shreddit-post post-id="t3_post1" post-title="Current"></shreddit-post>
    <shreddit-comment-tree post-id="t3_oldpost">
      <shreddit-comment thingid="t1_oldparent" parentid="t3_oldpost"><div slot="comment">Old root</div>
        <shreddit-comment thingid="t1_oldchild"><div slot="comment">Old child</div>
          <shreddit-comment thingid="t1_oldgrandchild" parentid="t1_oldchild"><div slot="comment">Old grandchild</div></shreddit-comment>
        </shreddit-comment>
      </shreddit-comment>
    </shreddit-comment-tree>
    <shreddit-comment-tree post-id="t3_post1"><shreddit-comment thingid="t1_current" parentid="t3_post1"><div slot="comment">Current reply</div></shreddit-comment></shreddit-comment-tree>`);
  assert.deepEqual(thread.comments.map((comment) => comment.id), ['t1_current']);
});

test('excludes flattened stale descendants even when their foreign root appears later', () => {
  const thread = extract(`<shreddit-post post-id="t3_post1" post-title="Current"></shreddit-post>
    <shreddit-comment-tree>
      <shreddit-comment thingid="t1_oldgrandchild" parentid="t1_oldchild"><div slot="comment">Old grandchild</div></shreddit-comment>
      <shreddit-comment thingid="t1_oldchild" parentid="t1_oldparent"><div slot="comment">Old child</div></shreddit-comment>
      <shreddit-comment thingid="t1_oldparent" parentid="t3_oldpost"><div slot="comment">Old root</div></shreddit-comment>
      <shreddit-comment thingid="t1_current" parentid="t3_post1"><div slot="comment">Current reply</div></shreddit-comment>
    </shreddit-comment-tree>`);
  assert.deepEqual(thread.comments.map((comment) => comment.id), ['t1_current']);
});

test('explicit foreign comment permalinks exclude their descendants without a root parent hint', () => {
  const thread = extract(`<shreddit-post post-id="t3_post1" post-title="Current"></shreddit-post>
    <shreddit-comment thingid="t1_oldparent" permalink="/r/test/comments/oldpost/old/oldparent/"><div slot="comment">Old root</div></shreddit-comment>
    <shreddit-comment thingid="t1_oldchild" parentid="t1_oldparent"><div slot="comment">Old child</div></shreddit-comment>
    <shreddit-comment thingid="t1_current" permalink="/r/test/comments/post1/example/current/"><div slot="comment">Current reply</div></shreddit-comment>`);
  assert.deepEqual(thread.comments.map((comment) => comment.id), ['t1_current']);
});
