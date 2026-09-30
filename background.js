import { initializeStorage } from './storage.js';

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com']);
const READER_TTL = 86_400_000;
const CHALLENGE_TTL = 30_000;
const TOKEN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const COMMENT_ID = /^[a-z0-9]{1,32}$/;
const extensionURL = new URL(chrome.runtime.getURL(''));

function redditThread(url) {
  if (url.protocol !== 'https:' || url.port || !REDDIT_HOSTS.has(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i);
  return match ? `t3_${match[1].toLowerCase()}` : null;
}

function isPanel(url, message) {
  return url.protocol === extensionURL.protocol && url.host === extensionURL.host &&
    url.pathname === '/panel.html' && url.searchParams.get('token') === message.token &&
    url.searchParams.get('threadId') === message.threadId;
}

function samePanel(record, sender) {
  return record.frameId === sender.frameId && record.panelDocumentId === sender.documentId;
}

function validRedditRequest(request) {
  if (!request || typeof request !== 'object') return false;
  if (request.kind === 'thread') return request.commentId === undefined ||
    (typeof request.commentId === 'string' && COMMENT_ID.test(request.commentId));
  return request.kind === 'more' && Array.isArray(request.children) && request.children.length > 0 &&
    request.children.length <= 100 && request.children.every((id) => typeof id === 'string' && COMMENT_ID.test(id));
}

async function removeReaders(predicate) {
  const all = await chrome.storage.session.get(null);
  const tokens = new Set(Object.entries(all).filter(([key, value]) => key.startsWith('reader:') && predicate(value)).map(([key]) => key.slice(7)));
  const keys = Object.entries(all).filter(([key, value]) =>
    (key.startsWith('reader:') && tokens.has(key.slice(7))) ||
    (key.startsWith('readerChallenge:') && (tokens.has(value.token) || Date.now() - value.createdAt > CHALLENGE_TTL))
  ).map(([key]) => key);
  if (keys.length) await chrome.storage.session.remove(keys);
}

chrome.runtime.onInstalled.addListener(() => initializeStorage().catch((error) => console.error('Reddit Distill : impossible d’initialiser le stockage.', error)));

// Tokens alone are insufficient: Reddit can observe iframe postMessage events.
// A challenge must travel through the exact iframe in the content script's
// closed shadow root before that frame may access a page snapshot or settings.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['registerReader', 'validateReader', 'authorizeReader', 'unregisterReader', 'readPageSnapshot',
    'fetchRedditJson', 'collectPageComments', 'cancelRedditRequest'].includes(message?.action)) return;
  (async () => {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
        !sender.documentId || !TOKEN.test(message.token || '') || !/^t3_[a-z0-9]+$/.test(message.threadId || '')) return { ok: false };
    await initializeStorage();
    const url = new URL(sender.url);
    const key = `reader:${message.token}`;
    if (message.action === 'registerReader') {
      if (sender.frameId !== 0 || redditThread(url) !== message.threadId) return { ok: false };
      await removeReaders((value) => value.tabId === sender.tab.id || Date.now() - value.createdAt > READER_TTL);
      await chrome.storage.session.set({ [key]: {
        tabId: sender.tab.id, origin: url.origin, threadId: message.threadId,
        documentId: sender.documentId, createdAt: Date.now(),
      } });
      return { ok: true };
    }
    const record = (await chrome.storage.session.get(key))[key];
    if (!record || record.tabId !== sender.tab.id || record.threadId !== message.threadId || Date.now() - record.createdAt > READER_TTL) return { ok: false };
    if (message.action === 'unregisterReader' || message.action === 'authorizeReader') {
      if (sender.frameId !== 0 || sender.documentId !== record.documentId || url.origin !== record.origin) return { ok: false };
      if (message.action === 'unregisterReader') {
        const all = await chrome.storage.session.get(null);
        const keys = Object.entries(all).filter(([name, value]) => name === key ||
          (name.startsWith('readerChallenge:') && value.token === message.token)).map(([name]) => name);
        if (keys.length) await chrome.storage.session.remove(keys);
        return { ok: true };
      }
      if (redditThread(url) !== record.threadId || !TOKEN.test(message.challenge || '')) return { ok: false };
      const challengeKey = `readerChallenge:${message.challenge}`;
      const pending = (await chrome.storage.session.get(challengeKey))[challengeKey];
      if (!pending || pending.token !== message.token || pending.tabId !== record.tabId || Date.now() - pending.createdAt > CHALLENGE_TTL ||
          (record.panelDocumentId && (record.panelDocumentId !== pending.documentId || record.frameId !== pending.frameId))) return { ok: false };
      await chrome.storage.session.set({ [key]: { ...record, frameId: pending.frameId, panelDocumentId: pending.documentId } });
      await chrome.storage.session.remove(challengeKey);
      return { ok: true };
    }
    if (sender.frameId <= 0 || !isPanel(url, message) || url.searchParams.get('origin') !== record.origin) return { ok: false };
    if (message.action === 'validateReader') {
      if (record.panelDocumentId) return { ok: samePanel(record, sender), ...(samePanel(record, sender) ? { origin: record.origin } : {}) };
      const challenge = crypto.randomUUID();
      await chrome.storage.session.set({ [`readerChallenge:${challenge}`]: {
        token: message.token, tabId: sender.tab.id, frameId: sender.frameId,
        documentId: sender.documentId, createdAt: Date.now(),
      } });
      return { ok: true, origin: record.origin, challenge };
    }
    if (!samePanel(record, sender)) return { ok: false };
    if (['fetchRedditJson', 'collectPageComments', 'cancelRedditRequest'].includes(message.action)) {
      if (typeof message.requestId !== 'string' || !REQUEST_ID.test(message.requestId) ||
          (message.action === 'fetchRedditJson' && !validRedditRequest(message.request))) return { ok: false, error: 'Requête Reddit invalide.' };
      const result = await chrome.tabs.sendMessage(record.tabId, {
        action: message.action, token: message.token, threadId: record.threadId, requestId: message.requestId,
        ...(message.action === 'fetchRedditJson' ? { request: message.request } : {}),
      }, { frameId: 0, documentId: record.documentId });
      if (message.action === 'collectPageComments' && result?.ok && result.thread?.id !== record.threadId)
        return { ok: false, error: 'La discussion Reddit a changé. Rouvre Distill.' };
      return result || { ok: false, error: 'Impossible de joindre la discussion Reddit.' };
    }
    const snapshot = await chrome.tabs.sendMessage(record.tabId, {
      action: 'readPageSnapshot', token: message.token, threadId: record.threadId,
    }, { frameId: 0, documentId: record.documentId });
    return snapshot?.ok && snapshot.thread?.id === record.threadId ? snapshot : { ok: false, error: snapshot?.error || 'La discussion Reddit a changé. Rouvre Distill.' };
  })().then(respond, () => respond({ ok: false, error: 'Impossible de joindre cette discussion. Recharge Reddit et rouvre Distill.' }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => removeReaders((value) => value.tabId === tabId).catch((error) => console.error('Reddit Distill : impossible de nettoyer les sessions du lecteur.', error)));
chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id) || !tab.url || !redditThread(new URL(tab.url))) return;
  try { await chrome.tabs.sendMessage(tab.id, { action: 'openReader' }, { frameId: 0 }); }
  catch { await chrome.action.setTitle({ tabId: tab.id, title: 'Recharge cette discussion Reddit pour activer Distill' }); }
});
