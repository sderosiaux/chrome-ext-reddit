// Keep Reddit fullnames throughout: post and comment ID spaces can overlap.
const POST_ID = /^t3_[a-z0-9]+$/;
const COMMENT_ID = /^t1_[a-z0-9]+$/;
const REDDIT_ORIGIN = /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com$/;
const MAX_EXPANSION_REQUESTS = 100;

export function threadUrl(id, threadId) {
  const value = String(id || '');
  const post = String(threadId || '').replace(/^t3_/, '');
  if (COMMENT_ID.test(value) && /^[a-z0-9]+$/.test(post))
    return `https://www.reddit.com/comments/${post}/_/${value.slice(3)}/`;
  if (COMMENT_ID.test(value)) return `https://www.reddit.com/api/info?id=${value}`;
  const bare = value.replace(/^t3_/, '');
  return /^[a-z0-9]+$/.test(bare) ? `https://www.reddit.com/comments/${bare}/` : 'https://www.reddit.com/';
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function redditUrl(value, fallback) {
  try {
    const url = new URL(value || fallback, 'https://www.reddit.com');
    return REDDIT_ORIGIN.test(url.origin) ? url.href : fallback;
  } catch { return fallback; }
}

export function cleanHtml(html = '') {
  let value = String(html ?? '');
  // Decode an entity-escaped body_html wrapper once, never the body text twice.
  if (/^\s*&lt;(?:div|p)\b/i.test(value))
    value = new DOMParser().parseFromString(value, 'text/html').body.textContent;
  const doc = new DOMParser().parseFromString(value, 'text/html');
  doc.querySelectorAll('script,style,iframe,object').forEach((el) => el.remove());
  const links = [...doc.querySelectorAll('a[href]')].map((a) => {
    let url = null;
    try { url = safeUrl(new URL(a.getAttribute('href'), 'https://www.reddit.com').href); } catch { /* invalid link */ }
    return { url, label: a.textContent.trim() };
  }).filter((link) => link.url);
  doc.querySelectorAll('p,div,br,li,pre,blockquote').forEach((el) => el.prepend('\n'));
  return { text: doc.body.textContent.replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), links };
}

function bodyContent(body, html) {
  const unavailable = /^\[(?:deleted|removed)\]$/i.test(String(body || '').trim());
  if (unavailable) return { text: '', links: [], unavailable: true };
  const content = html ? cleanHtml(html) : { text: String(body || '').trim(), links: [] };
  if (!html) {
    for (const match of content.text.matchAll(/https?:\/\/[^\s<>\])]+/g))
      if (safeUrl(match[0])) content.links.push({ url: match[0], label: match[0] });
  }
  return { ...content, unavailable: !content.text };
}

export function processThreadData(raw, nodes = [], coverage = {}) {
  const id = raw.name || `t3_${raw.id}`;
  if (!POST_ID.test(id)) throw new Error('Discussion Reddit invalide.');
  const post = bodyContent(raw.selftext, raw.selftext_html);
  const permalink = redditUrl(raw.permalink, threadUrl(id));
  const comments = nodes.filter((node) => COMMENT_ID.test(node.name || `t1_${node.id}`)).map((node) => {
    const commentId = node.name || `t1_${node.id}`;
    return {
      id: commentId, parent: /^(?:t1|t3)_[a-z0-9]+$/.test(node.parent_id) ? node.parent_id : id,
      author: node.author === '[deleted]' ? '' : node.author || '',
      ...bodyContent(node.body, node.body_html),
      permalink: redditUrl(node.permalink, threadUrl(commentId, id)),
      score: Number.isFinite(node.score) ? node.score : null,
    };
  });
  const reported = Number.isSafeInteger(raw.num_comments) && raw.num_comments >= 0 ? raw.num_comments : null;
  const external = raw.is_self ? null : safeUrl(raw.url_overridden_by_dest || raw.url);
  return {
    id, title: String(raw.title || 'Discussion Reddit'), author: raw.author === '[deleted]' ? '' : raw.author || '',
    text: post.text, links: post.links, url: external === permalink ? null : external,
    subreddit: String(raw.subreddit || ''), permalink, comments,
    coverage: { complete: false, loaded: comments.length, reported, reason: '', source: 'json', ...coverage },
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function getJson(url, signal, requestJson, request) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    // In the extension, Reddit requests run in its own tab so they have the
    // page's same-origin session. Direct fetch remains useful outside Chrome.
    const response = requestJson ? await requestJson(request) : await fetch(url, {
      credentials: 'include', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { Accept: 'application/json' },
    });
    signal.throwIfAborted();
    if (response.status === 429 && attempt === 0) {
      const retry = requestJson ? response.retryAfter : response.headers.get('retry-after');
      const seconds = Number(retry);
      const wait = retry && Number.isFinite(seconds) ? seconds * 1000 : Math.max(1000, Date.parse(retry) - Date.now() || 1000);
      // Do not hold the reader indefinitely for a server-imposed cooldown.
      if (wait <= 5000) { await delay(Math.max(250, wait), signal); continue; }
    }
    if (!response.ok) throw new Error(response.status === 429
      ? 'Reddit limite temporairement les requêtes (HTTP 429).'
      : response.status ? `Reddit : HTTP ${response.status}.` : response.error || 'Impossible de joindre Reddit depuis cet onglet.');
    try { return requestJson ? response.data : await response.json(); }
    catch { throw new Error('Reddit n’a pas renvoyé les commentaires au format JSON.'); }
  }
}

function listing(data, expectedPost) {
  if (!Array.isArray(data) || data[0]?.data?.children?.[0]?.kind !== 't3' || !Array.isArray(data[1]?.data?.children))
    throw new Error('La réponse Reddit ne contient pas de discussion exploitable.');
  const root = data[0].data.children[0].data;
  if ((root.name || `t3_${root.id}`) !== expectedPost) throw new Error('Reddit a renvoyé une autre discussion.');
  return { root, things: data[1].data.children };
}

function orderComments(nodes, rootId) {
  const children = new Map();
  for (const node of nodes.values()) {
    const parent = nodes.has(node.parent_id) || node.parent_id === rootId ? node.parent_id : rootId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const ordered = [], seen = new Set(), stack = [...(children.get(rootId) || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node.name)) continue;
    seen.add(node.name); ordered.push(node);
    stack.push(...[...(children.get(node.name) || [])].reverse());
  }
  // Preserve malformed/cyclic orphan records too; they must not disappear.
  for (const node of nodes.values()) if (!seen.has(node.name)) ordered.push(node);
  return ordered;
}

// Parent existence alone is insufficient: a cycle has every parent present
// while no comment in that branch is connected to the requested post.
function completeAncestry(nodes, rootId, parentKey) {
  const connected = new Set([rootId]);
  for (const id of nodes.keys()) {
    const branch = new Set();
    let next = id;
    while (!connected.has(next)) {
      if (branch.has(next) || !nodes.has(next)) return false;
      branch.add(next);
      next = nodes.get(next)[parentKey];
    }
    for (const parentId of branch) connected.add(parentId);
  }
  return true;
}

export async function fetchThread(threadId, { signal, onProgress = () => {}, onStatus = () => {}, origin = 'https://www.reddit.com', requestJson, collectComments, getSnapshot } = {}) {
  signal ||= new AbortController().signal;
  signal.throwIfAborted();
  const id = String(threadId).replace(/^t3_/, '');
  if (!/^[a-z0-9]+$/.test(id)) throw new Error('Identifiant Reddit invalide.');
  if (!REDDIT_ORIGIN.test(origin)) throw new Error('Origine Reddit invalide.');
  const rootId = `t3_${id}`;
  const endpoint = new URL(`/comments/${id}.json`, origin);
  endpoint.search = new URLSearchParams({ raw_json: '1', limit: '500', sort: 'confidence' });
  const nodes = new Map(), pending = new Set(), attempted = new Set(), branches = new Set(), visitedBranches = new Set();
  let root, incomplete = false, problem = '', requests = 0;
  function collect(things) {
    const stack = [...things].reverse();
    while (stack.length) {
      const thing = stack.pop(), data = thing?.data;
      if (!data) continue;
      if (thing.kind === 't1') {
        const name = data.name || `t1_${data.id}`;
        if (!COMMENT_ID.test(name) || (data.link_id && data.link_id !== rootId)) { incomplete = true; continue; }
        nodes.set(name, { ...data, name }); pending.delete(name.slice(3));
        if (Array.isArray(data.replies?.data?.children)) stack.push(...[...data.replies.data.children].reverse());
      } else if (thing.kind === 'more') {
        if (Array.isArray(data.children) && data.children.length) {
          for (const child of data.children) {
            if (!/^[a-z0-9]+$/.test(child)) { incomplete = true; continue; }
            if (!nodes.has(`t1_${child}`) && !attempted.has(child)) pending.add(child);
          }
        } else if (COMMENT_ID.test(data.parent_id)) {
          if (!visitedBranches.has(data.parent_id)) branches.add(data.parent_id);
          else incomplete = true;
        } else if (data.count > 0) incomplete = true;
      }
    }
  }
  try {
    onStatus('Récupération de la discussion depuis Reddit…');
    const initial = listing(await getJson(endpoint.href, signal, requestJson, { kind: 'thread' }), rootId);
    root = initial.root; collect(initial.things); onProgress(nodes.size);
    while (pending.size || branches.size) {
      signal.throwIfAborted();
      if (++requests > MAX_EXPANSION_REQUESTS) { problem = 'La limite de chargement a été atteinte ; une partie des réponses reste inaccessible.'; break; }
      if (pending.size) {
        const ids = [...pending].filter((child) => !nodes.has(`t1_${child}`)).slice(0, 100);
        for (const child of ids) { pending.delete(child); attempted.add(child); }
        for (const child of [...pending]) if (nodes.has(`t1_${child}`)) pending.delete(child);
        if (!ids.length) continue;
        const url = new URL('/api/morechildren.json', origin);
        url.search = new URLSearchParams({ api_type: 'json', raw_json: '1', link_id: rootId, children: ids.join(','), sort: 'confidence' });
        const response = await getJson(url.href, signal, requestJson, { kind: 'more', children: ids });
        if (response?.json?.errors?.length || !Array.isArray(response?.json?.data?.things))
          throw new Error('Reddit n’a pas fourni toutes les réponses supplémentaires.');
        collect(response.json.data.things);
        if (ids.some((child) => !nodes.has(`t1_${child}`))) incomplete = true;
      } else {
        const parent = branches.values().next().value;
        branches.delete(parent); visitedBranches.add(parent);
        const url = new URL(endpoint);
        url.searchParams.set('comment', parent.slice(3)); url.searchParams.set('context', '0');
        collect(listing(await getJson(url.href, signal, requestJson, { kind: 'thread', commentId: parent.slice(3) }), rootId).things);
      }
      onProgress(nodes.size);
    }
  } catch (error) {
    signal.throwIfAborted();
    problem = error.message || 'Le chargement Reddit a échoué.';
  }
  signal.throwIfAborted();
  const reported = Number.isSafeInteger(root?.num_comments) && root.num_comments >= 0 ? root.num_comments : null;
  if (!completeAncestry(nodes, rootId, 'parent_id')) incomplete = true;
  const partialReason = 'Certains commentaires annoncés par Reddit restent inaccessibles après la collecte automatique.';
  if (!root || problem || incomplete || (reported !== null && nodes.size < reported)) {
    let page, collectionError;
    if (collectComments) {
      onStatus('Chargement automatique des réponses supplémentaires…');
      try { page = await collectComments(); }
      catch (error) { signal.throwIfAborted(); collectionError = error.message; }
    }
    if (!page) try { page = await getSnapshot?.(); } catch { signal.throwIfAborted(); }
    signal.throwIfAborted();
    if (page?.id === rootId && Array.isArray(page.comments)) {
      const pageNodes = new Map(page.comments.map((comment) => [comment.id, comment]));
      const pageComplete = page.coverage?.source === 'page-auto' && page.coverage.complete === true &&
        Number.isSafeInteger(page.coverage.reported) && page.coverage.reported >= 0 &&
        pageNodes.size >= page.coverage.reported && completeAncestry(pageNodes, rootId, 'parent');
      if (!root) return { ...page, coverage: { ...page.coverage, complete: pageComplete, loaded: page.comments.length,
        source: page.coverage?.source === 'page-auto' ? 'page-auto' : 'page', reason: pageComplete ? '' : collectionError || page.coverage?.reason || (/429/.test(problem) ? problem : partialReason) } };
      // Keep successful API work; merge additional on-page comments.
      const result = processThreadData(root, orderComments(nodes, rootId));
      const comments = new Map(result.comments.map((comment) => [comment.id, comment]));
      for (const comment of page.comments) if (!comments.has(comment.id)) comments.set(comment.id, comment);
      result.comments = [...comments.values()];
      const graphComplete = completeAncestry(comments, rootId, 'parent');
      const complete = pageComplete && graphComplete && (reported === null || result.comments.length >= reported);
      const missing = reported === null ? null : Math.max(0, reported - result.comments.length);
      const reason = missing > 0 ? `${missing} commentaire${missing === 1 ? '' : 's'} annoncé${missing === 1 ? '' : 's'} par Reddit n’${missing === 1 ? 'a' : 'ont'} pas été renvoyé${missing === 1 ? '' : 's'} après la collecte automatique.`
        : page.coverage?.reason || partialReason;
      result.coverage = { ...result.coverage, loaded: result.comments.length, reason: complete ? '' : reason, complete };
      return result;
    }
    if (!root) throw new Error(collectionError || 'Le chargement automatique n’a pas pu accéder à cette discussion. Recharge Reddit puis réessaie.');
  }
  const complete = !problem && !incomplete && !pending.size && !branches.size && reported !== null && nodes.size >= reported;
  const reason = problem || (complete ? '' : 'Certains commentaires signalés par Reddit ne sont pas accessibles dans les données reçues.');
  return processThreadData(root, orderComments(nodes, rootId), { complete, reason });
}

export function sourceMap(thread) {
  return new Map([[thread.id, { ...thread, parent: null }], ...thread.comments.map((c) => [c.id, c])]);
}

// Budget every JSON byte, including escaping and ancestor context. Splitting at
// codepoint boundaries keeps emoji intact and preserves every source character.
const utf8 = new TextEncoder();
const jsonBytes = (value) => utf8.encode(JSON.stringify(value)).length;
function splitJsonText(text, budget) {
  const parts = [];
  let part = '', size = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const length = character === '"' || character === '\\' ? 2
      : /[\b\f\n\r\t]/.test(character) ? 2
      : code < 32 || (code >= 0xd800 && code <= 0xdfff) ? 6
      : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (length > budget) throw new Error('Le budget de lecture est trop petit pour préserver le texte et son contexte.');
    if (size + length > budget && part) { parts.push(part); part = ''; size = 0; }
    part += character; size += length;
  }
  if (part) parts.push(part);
  return parts;
}

export function partitionThread(thread, budget = 160_000) {
  if (!Number.isSafeInteger(budget) || budget < 256) throw new Error('Budget de lecture invalide.');
  const all = sourceMap(thread);
  const chunks = [], branches = new Map();
  const recordBudget = Math.floor(budget * .75);
  const envelopeBytes = jsonBytes({ comments: [], context: [] });
  const nodeText = (node) => node.id === thread.id ? `${thread.title}\n\n${node.text || ''}`.trim() : node.text;
  let records = [], size = envelopeBytes;
  const flush = () => { if (records.length) chunks.push(records); records = []; size = envelopeBytes; };
  for (const node of [thread, ...thread.comments]) {
    const text = nodeText(node);
    if (!text) continue;
    const path = [], visited = new Set([node.id]);
    let parent = all.get(node.parent);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id); path.unshift(parent.id); parent = all.get(parent.parent);
    }
    const branchId = node.id === thread.id ? thread.id : path[1] || node.id;
    if (!branches.has(branchId)) branches.set(branchId, []);
    const metadata = { id: node.id, parent: node.parent || null, ancestors: path, author: node.author };
    // Reserve continuation:false, the longer of the two flags, before slicing.
    const metadataBytes = jsonBytes({ ...metadata, text: '', continuation: false });
    const partBudget = Math.min(Math.floor(budget / 4), recordBudget - envelopeBytes - metadataBytes);
    if (partBudget < 1) throw new Error('La structure de cette discussion est trop profonde pour être analysée sans perte de contexte.');
    const parts = splitJsonText(text, partBudget);
    parts.forEach((part, index) => branches.get(branchId).push({
      ...metadata, text: part, ...(parts.length > 1 ? { continuation: index > 0 } : {}),
    }));
  }
  for (const branch of branches.values()) {
    const branchSize = branch.reduce((total, record) => total + jsonBytes(record), 0) + Math.max(0, branch.length - 1);
    if (branchSize + envelopeBytes <= recordBudget && size + branchSize + (records.length ? 1 : 0) > recordBudget) flush();
    for (const record of branch) {
      const length = jsonBytes(record);
      if (size + length + (records.length ? 1 : 0) > recordBudget) flush();
      size += length + (records.length ? 1 : 0); records.push(record);
    }
  }
  flush();
  return chunks.map((comments) => {
    const present = new Set(comments.map((comment) => comment.id));
    const parents = new Set(comments.flatMap((comment) => comment.ancestors));
    const context = [];
    let payloadBytes = jsonBytes({ comments, context });
    for (const id of parents) {
      if (present.has(id)) continue;
      const parent = all.get(id);
      const entry = { id, parent: parent.parent || null, author: parent.author, excerpt: [...(nodeText(parent) || '')].slice(0, 1200).join('') };
      const addedBytes = jsonBytes(entry) + (context.length ? 1 : 0);
      if (payloadBytes + addedBytes <= budget) { context.push(entry); payloadBytes += addedBytes; }
    }
    return { comments, context };
  });
}
