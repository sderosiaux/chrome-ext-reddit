import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const EXTENSION_ID = 'a'.repeat(32);
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const TOKEN = '11111111-1111-4111-8111-111111111111';
const THREAD = 't3_1wo8160';
const URL_REDDIT = 'https://www.reddit.com/r/ExperiencedDevs/comments/1wo8160/example/';
const backgroundSource = (await readFile(new URL('../background.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '');
const contentSource = await readFile(new URL('../content.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function backgroundHarness() {
  const store = {};
  const calls = [];
  let listener;
  let onRemoved;
  let now = Date.now();
  const chrome = {
    runtime: {
      id: EXTENSION_ID, getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
      onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } },
    },
    storage: { session: {
      async get(key) { return structuredClone(key === null ? store : { [key]: store[key] }); },
      async set(values) { Object.assign(store, structuredClone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
    } },
    tabs: {
      onRemoved: { addListener(fn) { onRemoved = fn; } },
      async sendMessage(...args) { calls.push(args); return { ok: true, thread: { id: THREAD, comments: [] } }; },
    },
    action: { onClicked: { addListener() {} } },
  };
  vm.runInNewContext(backgroundSource, { chrome, initializeStorage: async () => {}, URL, crypto: webcrypto, Date: { now: () => now }, console });
  const content = { id: EXTENSION_ID, tab: { id: 17 }, frameId: 0, documentId: 'reddit-document', url: URL_REDDIT };
  const panel = { id: EXTENSION_ID, tab: { id: 17 }, frameId: 3, documentId: 'panel-document', url: `${EXTENSION_ORIGIN}/panel.html?${new URLSearchParams({ token: TOKEN, threadId: THREAD, origin: new URL(URL_REDDIT).origin })}` };
  function send(action, sender = content, extra = {}) {
    return new Promise((resolve) => listener({ action, token: TOKEN, threadId: THREAD, ...extra }, sender, (result) => resolve(structuredClone(result))));
  }
  async function authorize() {
    assert.equal((await send('registerReader')).ok, true);
    const initial = await send('validateReader', panel);
    assert.equal(initial.origin, new URL(URL_REDDIT).origin);
    assert.ok(initial.challenge);
    assert.equal((await send('authorizeReader', content, { challenge: initial.challenge })).ok, true);
    return send('validateReader', panel);
  }
  return { chrome, store, calls, content, panel, send, authorize, onRemoved: (id) => onRemoved(id), advance: (ms) => { now += ms; } };
}

test('reader binds a top-level Reddit document and exact iframe before relaying a snapshot', async () => {
  const app = backgroundHarness();
  const authorization = await app.authorize();
  assert.deepEqual(authorization, { ok: true, origin: 'https://www.reddit.com' });
  assert.equal((await app.send('readPageSnapshot', app.panel)).ok, true);
  assert.equal(app.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0])), [17,
    { action: 'readPageSnapshot', token: TOKEN, threadId: THREAD },
    { frameId: 0, documentId: 'reddit-document' },
  ]);
});

test('all supported Reddit origins and direct thread paths register; impostors do not', async () => {
  for (const host of ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com']) {
    const app = backgroundHarness();
    assert.equal((await app.send('registerReader', { ...app.content, url: `https://${host}/comments/1wo8160/` })).ok, true);
  }
  for (const url of ['https://evil.reddit.com/comments/1wo8160/', 'https://www.reddit.com.evil.test/comments/1wo8160/', 'http://www.reddit.com/comments/1wo8160/', 'https://www.reddit.com:444/comments/1wo8160/', 'https://www.reddit.com/r/ExperiencedDevs/', 'https://www.reddit.com/comments/other/']) {
    const app = backgroundHarness();
    assert.equal((await app.send('registerReader', { ...app.content, url })).ok, false, url);
  }
});

test('token replay in another iframe, document, tab, or parent origin fails', async () => {
  const app = backgroundHarness();
  await app.authorize();
  for (const sender of [
    { ...app.panel, frameId: 4 }, { ...app.panel, documentId: 'reloaded-frame' },
    { ...app.panel, tab: { id: 18 } }, { ...app.panel, frameId: 0 },
    { ...app.panel, id: 'another-extension' },
    { ...app.panel, url: app.panel.url.replace('www.reddit.com', 'old.reddit.com') },
    { ...app.panel, url: app.panel.url.replace('/panel.html', '/other.html') },
  ]) {
    assert.equal((await app.send('validateReader', sender)).ok, false);
    assert.equal((await app.send('readPageSnapshot', sender)).ok, false);
  }
  assert.equal(app.calls.length, 0);
});

test('candidate iframe cannot read or authorize itself; challenges expire and cannot replay', async () => {
  const app = backgroundHarness();
  await app.send('registerReader');
  const candidate = await app.send('validateReader', app.panel);
  assert.equal((await app.send('readPageSnapshot', app.panel)).ok, false);
  assert.equal((await app.send('authorizeReader', app.panel, { challenge: candidate.challenge })).ok, false);
  assert.equal((await app.send('authorizeReader', { ...app.content, documentId: 'other-document' }, { challenge: candidate.challenge })).ok, false);
  app.advance(30_001);
  assert.equal((await app.send('authorizeReader', app.content, { challenge: candidate.challenge })).ok, false);
  const valid = await app.send('validateReader', app.panel);
  assert.equal((await app.send('authorizeReader', app.content, { challenge: valid.challenge })).ok, true);
  assert.equal((await app.send('authorizeReader', app.content, { challenge: valid.challenge })).ok, false);
});

test('leaving a thread revokes the session and prevents later snapshot access', async () => {
  const app = backgroundHarness();
  await app.authorize();
  assert.equal((await app.send('unregisterReader', { ...app.content, url: 'https://www.reddit.com/' })).ok, true);
  assert.equal((await app.send('validateReader', app.panel)).ok, false);
  assert.equal((await app.send('readPageSnapshot', app.panel)).ok, false);
});

function contentHarness(initialURL = URL_REDDIT) {
  let listener;
  let interval;
  const messages = [];
  const posts = [];
  const windowEvents = {};
  const elements = [];
  const location = new URL(initialURL);
  const document = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.style = {}; this.open = false; elements.push(this); if (tag === 'iframe') this.contentWindow = { postMessage: (...args) => posts.push(args) }; }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    append(...nodes) { nodes.forEach((node) => { node.parent = this; this.children.push(node); }); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
    attachShadow() { this.shadow = new Element('shadow'); this.shadow.parent = this; return this.shadow; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
  }
  document.body = new Element('body');
  document.documentElement = document.body;
  document.createElement = (tag) => new Element(tag);
  const chrome = { runtime: {
    id: EXTENSION_ID, getURL: (path) => `${EXTENSION_ORIGIN}/${path}`,
    async sendMessage(message) { messages.push(message); return { ok: true }; },
    onMessage: { addListener(fn) { listener = fn; } },
  } };
  vm.runInNewContext(contentSource, {
    window: { addEventListener(name, fn) { windowEvents[name] = fn; } }, document, chrome, location, URL, URLSearchParams, crypto: webcrypto,
    setTimeout: (fn) => fn(), setInterval: (fn) => { interval = fn; }, MutationObserver: class { observe() {} },
    RedditDistillDOM: { extractThread: () => ({ id: THREAD, comments: [] }) },
  });
  const message = (data) => new Promise((resolve) => listener(data, { id: EXTENSION_ID }, (result) => resolve(structuredClone(result))));
  const open = async () => { await message({ action: 'openReader' }); await flush(); };
  const frame = () => elements.filter((el) => el.tagName === 'iframe' && el.isConnected).at(-1);
  const registration = () => messages.filter((msg) => msg.action === 'registerReader').at(-1);
  async function authorize() {
    windowEvents.message({ isTrusted: true, source: frame().contentWindow, origin: EXTENSION_ORIGIN, data: { action: 'authorize', token: registration().token, challenge: TOKEN } });
    await flush();
  }
  return { document, elements, messages, posts, windowEvents, location, message, open, frame, registration, authorize, sync: () => interval() };
}

test('page-script FAB clicks cannot open a reader; trusted user clicks can', async () => {
  const app = contentHarness();
  const button = app.document.body.children.find((element) => element.tagName === 'button');
  button.listeners.click({ isTrusted: false });
  await flush();
  assert.equal(app.frame(), undefined);
  assert.equal(app.messages.filter((message) => message.action === 'registerReader').length, 0);
  button.listeners.click({ isTrusted: true });
  await flush();
  assert.ok(app.frame());
  assert.equal(app.messages.filter((message) => message.action === 'registerReader').length, 1);
});

test('content follows SPA routes, preserves one button, and tears down an old reader', async () => {
  const app = contentHarness('https://www.reddit.com/');
  assert.equal(app.document.body.children.length, 0);
  app.location.href = URL_REDDIT;
  app.sync(); app.sync();
  assert.equal(app.document.body.children.filter((el) => el.tagName === 'button').length, 1);
  await app.open();
  const first = app.frame();
  assert.equal(new URL(first.src).searchParams.get('origin'), 'https://www.reddit.com');
  app.location.href = 'https://www.reddit.com/r/programming/comments/abc123/other/';
  app.sync();
  assert.equal(first.isConnected, false);
  assert.equal(app.messages.some((msg) => msg.action === 'unregisterReader'), true);
  await app.open();
  assert.equal(app.registration().threadId, 't3_abc123');
  app.location.href = 'https://www.reddit.com/r/programming/';
  app.sync();
  assert.equal(app.document.body.children.length, 0);
});

test('content accepts only trusted messages from its exact iframe and verifies snapshot session', async () => {
  const app = contentHarness();
  await app.open();
  const token = app.registration().token;
  const event = { isTrusted: true, source: app.frame().contentWindow, origin: EXTENSION_ORIGIN, data: { action: 'authorize', token, challenge: TOKEN } };
  app.windowEvents.message({ ...event, isTrusted: false });
  app.windowEvents.message({ ...event, source: {} });
  app.windowEvents.message({ ...event, origin: 'https://www.reddit.com' });
  await flush();
  assert.equal(app.messages.filter((msg) => msg.action === 'authorizeReader').length, 0);
  assert.equal((await app.message({ action: 'readPageSnapshot', token, threadId: THREAD })).ok, false);
  await app.authorize();
  assert.equal((await app.message({ action: 'readPageSnapshot', token, threadId: THREAD })).ok, true);
  assert.equal((await app.message({ action: 'readPageSnapshot', token: TOKEN, threadId: THREAD })).ok, false);
  app.windowEvents.message({ ...event, data: { action: 'ready', token } });
  assert.equal(app.posts.at(-1)[0].action, 'opened');
  app.windowEvents.message({ ...event, data: { action: 'close', token } });
  assert.equal(app.posts.at(-1)[0].action, 'closed');
  await app.open();
  assert.equal(app.messages.filter((msg) => msg.action === 'registerReader').length, 1);
});
