import { test as base, expect, chromium } from '@playwright/test';
import path from 'node:path';

const ROOT = path.resolve('.');
const THREAD = 'https://www.reddit.com/r/ExperiencedDevs/comments/1wo8160/example/';
const fixture = `<!doctype html><html><head><title>A discussion · Reddit</title></head><body>
<h1>A discussion about AI at work</h1>
<shreddit-post id="t3_1wo8160" post-id="t3_1wo8160" post-title="A discussion about AI at work" author="originalposter" subreddit-prefixed-name="r/ExperiencedDevs" comment-count="3" permalink="/r/ExperiencedDevs/comments/1wo8160/example/">
<div slot="text-body"><p>How can we balance our principles and our work?</p></div></shreddit-post>
<shreddit-comment thingid="t1_a1" parentid="t3_1wo8160" author="alice" depth="0" permalink="/r/ExperiencedDevs/comments/1wo8160/example/a1/">
<div slot="comment"><p>I use the tools carefully, but still review the output.</p></div>
<shreddit-comment thingid="t1_b2" parentid="t1_a1" author="bob" depth="1"><div slot="comment"><p>Review is useful; preserving skills also matters.</p></div></shreddit-comment>
</shreddit-comment></body></html>`;
const oldFixture = `<!doctype html><html><body><div class="thing link" data-fullname="t3_1wo8160" data-subreddit="ExperiencedDevs" data-author="originalposter" data-comments-count="3">
<a class="title" href="/r/ExperiencedDevs/comments/1wo8160/example/">A discussion about AI at work</a>
<div class="usertext-body"><div class="md"><p>How can we balance our principles and our work?</p></div></div>
<a class="comments" href="/r/ExperiencedDevs/comments/1wo8160/example/">3 comments</a></div>
<div class="commentarea"><div class="thing comment" data-fullname="t1_a1" data-author="alice">
<div class="entry"><div class="usertext-body"><div class="md"><p>I use the tools carefully, but still review the output.</p></div></div></div>
<div class="child"><div class="thing comment" data-fullname="t1_b2" data-author="bob">
<div class="entry"><div class="usertext-body"><div class="md"><p>Review is useful; preserving skills also matters.</p></div></div></div>
</div></div></div></div></body></html>`;
const comment = (id, parent, text, author = 'alice') => ({ kind: 't1', data: {
  id, name: `t1_${id}`, parent_id: parent, link_id: 't3_1wo8160', author, body: text,
  permalink: `/r/ExperiencedDevs/comments/1wo8160/example/${id}/`, replies: '',
} });
const listing = [{ kind: 'Listing', data: { children: [{ kind: 't3', data: {
  id: '1wo8160', name: 't3_1wo8160', title: 'A discussion about AI at work', author: 'originalposter',
  subreddit: 'ExperiencedDevs', selftext: 'How can we balance our principles and our work?', is_self: true,
  num_comments: 3, permalink: '/r/ExperiencedDevs/comments/1wo8160/example/',
} }] } }, { kind: 'Listing', data: { children: [comment('a1', 't3_1wo8160', 'I use the tools carefully, but still review the output.'),
  { kind: 'more', data: { id: 'more1', parent_id: 't1_a1', count: 2, children: ['b2', 'c3'] } }] } }];

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
    });
    await use(context);
    await context.close();
  },
});

async function setup(context, { blocked = false, incomplete = false } = {}) {
  let calls = 0;
  await context.route(/^https:\/\/(www\.|old\.|new\.)?reddit\.com\//, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('.json') || url.pathname.includes('/api/')) {
      if (blocked) return route.fulfill({ status: 403, body: 'Blocked by Reddit' });
      const data = url.pathname.includes('morechildren')
        ? { json: { errors: [], data: { things: [comment('b2', 't1_a1', 'Review is useful; preserving skills also matters.', 'bob'), comment('c3', 't3_1wo8160', 'A different perspective.', 'carol')] } } }
        : listing;
      return route.fulfill({ json: data });
    }
    return route.fulfill({ contentType: 'text/html', body: url.hostname === 'old.reddit.com' ? oldFixture : fixture });
  });
  await context.route('https://api.openai.com/v1/responses', async route => {
    calls++;
    const body = route.request().postDataJSON();
    const qa = body.text.format.name.includes('questions');
    const result = { sections: [{ title: qa ? 'Comprendre les avis' : 'En bref', entries: [{
      kind: qa ? 'question' : 'argument', title: qa ? 'Comment préserver ses compétences ?' : 'Garder un regard critique',
      text: 'Les participants distinguent les gains pratiques des risques pour leurs compétences. Les objections portent sur les conditions de cette utilisation.',
      sources: ['t1_a1', 't1_b2'],
    }] }] };
    const events = [{ type: 'response.output_text.delta', delta: JSON.stringify(result) }];
    if (!incomplete) events.push({ type: 'response.completed', response: { status: 'completed', output: [] } });
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') });
  });
  return () => calls;
}

async function openReader(page) {
  await page.locator('#reddit-distill-button').click();
  await expect.poll(() => page.frames().some(f => f.url().includes('/panel.html'))).toBe(true);
  const frame = page.frames().find(f => f.url().includes('/panel.html'));
  await expect(frame.locator('#thread-title')).toHaveText('A discussion about AI at work');
  return frame;
}

test('real extension: JSON pagination, key setup, sources, Q/R, cache and keyboard', async ({ context }, testInfo) => {
  const calls = await setup(context);
  const page = await context.newPage();
  await page.goto(THREAD);
  const frame = await openReader(page);
  await expect(frame.locator('#coverage-title')).toContainText('3 commentaires lus');
  await expect(frame.locator('#settings-dialog')).toBeVisible();
  await frame.getByLabel('Clé API', { exact: true }).fill('sk-test-fixture-not-a-real-key');
  await frame.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(frame.locator('#reader h2')).toHaveText('En bref');
  await page.screenshot({ path: testInfo.outputPath('summary.png'), animations: 'disabled' });
  await frame.getByText('Sources · 2', { exact: true }).click();
  await expect(frame.locator('.source-comment').first()).toContainText('review the output');
  await expect(frame.getByRole('link', { name: 'Ouvrir sur Reddit ↗' }).first()).toHaveAttribute('href', /\/a1\/$/);
  await frame.getByRole('tab', { name: 'Questions-réponses' }).click();
  await expect(frame.locator('#reader h3')).toContainText('Comment préserver');
  await frame.getByRole('tab', { name: 'Synthèse', exact: true }).click();
  await expect(frame.locator('#reader h2')).toHaveText('En bref');
  expect(calls()).toBe(2);
  await frame.getByRole('tab', { name: 'Synthèse', exact: true }).press('End');
  await expect(frame.getByRole('tab', { name: 'Discussion', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(frame.locator('#reader')).toContainText('carol');
  await frame.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.locator('#reddit-distill-button').click();
  await expect(frame.locator('#reader')).toContainText('carol');
});

test('Reddit 403 falls back to page with persistent partial coverage; light, dark, narrow layout', async ({ context }, testInfo) => {
  await setup(context, { blocked: true });
  const page = await context.newPage();
  await page.goto(THREAD);
  const frame = await openReader(page);
  await frame.getByRole('button', { name: 'Fermer les paramètres' }).click();
  await expect(frame.locator('#coverage')).toContainText('Lecture partielle');
  await expect(frame.locator('#coverage-title')).toContainText('2 commentaires lus');
  await frame.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(frame.locator('#reader')).toContainText('alice');
  await expect(frame.locator('#coverage')).toContainText('Lecture partielle');
  await page.screenshot({ path: testInfo.outputPath('reader-light.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: testInfo.outputPath('reader-dark.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('reader-narrow.png'), animations: 'disabled' });
  await frame.getByRole('button', { name: 'Actualiser' }).click();
  await expect(frame.locator('#coverage')).toContainText('Lecture partielle');
});

test('incomplete generation stays visible and is never cached as complete', async ({ context }) => {
  const calls = await setup(context, { incomplete: true });
  const page = await context.newPage();
  await page.goto(THREAD);
  const frame = await openReader(page);
  await frame.getByLabel('Clé API', { exact: true }).fill('sk-test-fixture-not-a-real-key');
  await frame.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(frame.locator('#notice')).toContainText(/interrompue|incomplète/);
  await expect(frame.locator('#reader h2')).toHaveText('En bref');
  const cached = await frame.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('analysis:')));
  expect(cached).toEqual([]);
  await frame.getByRole('button', { name: 'Réessayer' }).click();
  await expect.poll(calls).toBe(2);
});

test('SPA thread changes remove old reader; landing pages never show a thread button', async ({ context }) => {
  await setup(context);
  const page = await context.newPage();
  await page.goto(THREAD);
  const frame = await openReader(page);
  await frame.getByRole('button', { name: 'Fermer les paramètres' }).click();
  await page.evaluate(() => history.pushState({}, '', '/r/ExperiencedDevs/'));
  await expect(page.locator('#reddit-distill-button')).toHaveCount(0);
  await expect.poll(() => page.frames().filter(f => f.url().includes('/panel.html')).length).toBe(0);
  await page.evaluate(() => history.pushState({}, '', '/r/ExperiencedDevs/comments/1wo8160/example/a1/'));
  await expect(page.locator('#reddit-distill-button')).toHaveCount(1);
  await openReader(page);
});

test('page-created replay iframe cannot authorize itself or read a snapshot', async ({ context }) => {
  await setup(context);
  const page = await context.newPage();
  await page.goto(THREAD);
  const frame = await openReader(page);
  const replayUrl = frame.url();
  await page.evaluate(src => {
    const iframe = document.createElement('iframe'); iframe.id = 'replayed-reader'; iframe.src = src; document.body.append(iframe);
  }, replayUrl);
  const replay = page.frameLocator('#replayed-reader');
  await expect(replay.locator('#notice')).toContainText(/pas été ouvert|pas été autorisé|expirée/);
  await expect(replay.locator('#settings-dialog')).not.toBeVisible();
  await expect(replay.locator('#thread-title')).toHaveText('Discussion Reddit');
});

test('retry after a failed refresh fetches new comments instead of reusing the previous thread', async ({ context }) => {
  await setup(context);
  const page = await context.newPage();
  await page.goto(THREAD);
  const frame = await openReader(page);
  await frame.getByRole('button', { name: 'Fermer les paramètres' }).click();
  await frame.getByRole('tab', { name: 'Discussion', exact: true }).click();
  let fail = true, attempts = 0;
  await context.route('**/comments/1wo8160.json?*', route => {
    attempts++;
    return fail ? route.fulfill({ status: 403, body: 'Blocked' }) : route.fulfill({ json: listing });
  });
  await page.evaluate(() => document.querySelector('shreddit-post').remove());
  await frame.getByRole('button', { name: 'Actualiser' }).click();
  await expect(frame.locator('#notice')).toContainText('réessaie');
  expect(attempts).toBe(1);
  fail = false;
  await frame.getByRole('button', { name: 'Réessayer' }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(frame.locator('#reader')).toContainText('carol');
});

test('old Reddit HTML fallback preserves post, comments and reply context', async ({ context }) => {
  await setup(context, { blocked: true });
  const page = await context.newPage();
  await page.goto(THREAD.replace('www.reddit.com', 'old.reddit.com'));
  const frame = await openReader(page);
  await frame.getByRole('button', { name: 'Fermer les paramètres' }).click();
  await expect(frame.locator('#coverage-title')).toContainText('2 commentaires lus');
  await frame.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(frame.locator('#reader')).toContainText('How can we balance our principles');
  await frame.locator('summary').filter({ hasText: 'u/bob' }).click();
  await expect(frame.locator('#reader')).toContainText('En réponse à u/alice');
  await expect(frame.locator('#coverage')).toContainText('Lecture partielle');
});
