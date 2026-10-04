(() => {
  if (window.redditDistillInitialized) return;
  window.redditDistillInitialized = true;
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const hosts = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com']);
  const requestIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
  const commentIdPattern = /^[a-z0-9]{1,32}$/;
  const requests = new Map();
  const cancelledRequests = new Set();
  let threadId = null;
  let session = null;
  let button = null;
  let scheduled = false;

  function currentThread() {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' || url.port || !hosts.has(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i);
    return match ? `t3_${match[1].toLowerCase()}` : null;
  }
  function send(message) { return chrome.runtime.sendMessage(message); }
  function abortRequests() {
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  }
  function close() {
    abortRequests();
    if (!session?.dialog.open) return;
    session.frame.contentWindow?.postMessage({ action: 'closed', token: session.token }, extensionOrigin);
    session.dialog.close();
    if (session.focus?.isConnected) session.focus.focus();
  }
  function destroy() {
    if (!session) return;
    close();
    const old = session;
    session = null;
    cancelledRequests.clear();
    old.host.remove(); // iframe pagehide aborts in-flight work, including startup.
    send({ action: 'unregisterReader', token: old.token, threadId: old.threadId }).catch(() => {});
  }
  function notifyOpen() {
    if (session?.ready && session.dialog.open) session.frame.contentWindow.postMessage({ action: 'opened', token: session.token }, extensionOrigin);
  }
  function redditEndpoint(request, id) {
    if (!request || typeof request !== 'object') throw new Error('Requête Reddit invalide.');
    if (request.kind === 'thread' && (request.commentId === undefined ||
        (typeof request.commentId === 'string' && commentIdPattern.test(request.commentId)))) {
      // Reddit accepts the canonical page route more consistently than the
      // short /comments/<id>.json route. Drop a focused comment from permalinks.
      const parts = new URL(location.href).pathname.split('/').filter(Boolean);
      const index = parts.findIndex((part) => part.toLowerCase() === 'comments');
      const path = parts.slice(0, index + 3).join('/').replace(/\.json$/, '');
      const url = new URL(`/${path}.json`, location.origin);
      url.search = new URLSearchParams({ raw_json: '1', limit: '500', sort: 'confidence' });
      if (request.commentId) { url.searchParams.set('comment', request.commentId); url.searchParams.set('context', '0'); }
      return url;
    }
    if (request.kind === 'more' && Array.isArray(request.children) && request.children.length > 0 &&
        request.children.length <= 100 && request.children.every((child) => typeof child === 'string' && commentIdPattern.test(child))) {
      const url = new URL('/api/morechildren.json', location.origin);
      url.search = new URLSearchParams({ api_type: 'json', raw_json: '1', link_id: id,
        children: [...new Set(request.children)].join(','), sort: 'confidence' });
      return url;
    }
    throw new Error('Requête Reddit invalide.');
  }
  async function fetchRedditJson(request, id, signal) {
    const url = redditEndpoint(request, id);
    const response = await fetch(url.href, { credentials: 'include', mode: 'same-origin', redirect: 'follow',
      headers: { Accept: 'application/json' }, signal });
    if (response.url && new URL(response.url).origin !== location.origin) throw new Error('Reddit a redirigé la requête vers une autre origine.');
    if (!response.ok) return { ok: false, status: response.status, retryAfter: response.headers.get('Retry-After'),
      error: response.status === 429 ? 'Reddit limite temporairement les requêtes (HTTP 429).' : `Reddit : HTTP ${response.status}.` };
    try { return { ok: true, data: await response.json() }; }
    catch { signal.throwIfAborted(); throw new Error('Reddit n’a pas renvoyé les commentaires au format JSON.'); }
  }
  async function runRequest(message, active, controller) {
    const { signal } = controller;
    let timedOut = false;
    // The loader returns partial data at its own deadline. This watchdog is
    // only a final safeguard and is never extended by progress messages.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, message.action === 'collectPageComments' ? 35_000 : 20_000);
    try {
      signal.throwIfAborted();
      let result;
      if (message.action === 'fetchRedditJson') result = await fetchRedditJson(message.request, active.threadId, signal);
      else {
        if (!globalThis.RedditDistillLoader?.collect) throw new Error('Le chargement automatique est indisponible. Recharge cette discussion Reddit.');
        const request = message.request;
        if (request !== undefined && (!Number.isSafeInteger(request?.timeBudgetMs) || request.timeBudgetMs < 0 || request.timeBudgetMs > 30000 ||
            !Array.isArray(request.knownCommentIds) || request.knownCommentIds.length > 15000 ||
            !request.knownCommentIds.every((id) => typeof id === 'string' && /^t1_[a-z0-9]{1,32}$/.test(id)))) throw new Error('Requête Reddit invalide.');
        const collected = await globalThis.RedditDistillLoader.collect({ ...request, threadId: active.threadId, signal, onProgress(progress) {
          if (signal.aborted || session !== active || currentThread() !== active.threadId) return;
          active.frame.contentWindow?.postMessage({ action: 'pageCollectionProgress', token: active.token, threadId: active.threadId,
            requestId: message.requestId, progress }, extensionOrigin);
        } });
        const thread = collected?.thread || collected;
        result = thread?.id === active.threadId ? { ok: true, thread }
          : { ok: false, error: 'Les commentaires de cette discussion ne sont pas encore disponibles.' };
      }
      signal.throwIfAborted();
      if (session !== active || currentThread() !== active.threadId) throw new Error('La discussion Reddit a changé. Rouvre Distill.');
      return result;
    } catch (error) {
      return { ok: false, error: timedOut ? 'Reddit met trop de temps à répondre.' : signal.aborted
        ? 'Chargement Reddit annulé.' : error.message || 'Impossible de charger les commentaires Reddit.',
      ...(signal.aborted ? { aborted: true } : {}) };
    } finally {
      clearTimeout(timer);
      // Collection results stay in this document until the reader's next poll.
      // No service-worker message needs to remain open for the whole traversal.
      if (!controller.collecting && requests.get(message.requestId) === controller) requests.delete(message.requestId);
    }
  }
  function open() {
    syncPage();
    if (!threadId || !document.body) return;
    if (!session) {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host{all:initial;color-scheme:light;--reader-paper:#fff;--reader-ink:#282b27;--reader-line:#e5e6e0;--reader-shadow:#282b2733}
        dialog{box-sizing:border-box;padding:0;border:1px solid var(--reader-line);border-radius:12px;width:min(1120px,calc(100vw - 32px));height:calc(100dvh - 40px);max-width:none;max-height:none;background:var(--reader-paper);color:var(--reader-ink);box-shadow:0 25px 90px var(--reader-shadow);overflow:hidden;color-scheme:inherit}
        dialog::backdrop{background:#282b2752}
        iframe{display:block;width:100%;height:100%;border:0;background:var(--reader-paper);color-scheme:inherit}
        @media(prefers-color-scheme:dark){
          :host{color-scheme:dark;--reader-paper:#201d1b;--reader-ink:#eee9e3;--reader-line:#443c36;--reader-shadow:#00000080}
          dialog::backdrop{background:#00000080}
        }
        @media(max-width:640px){dialog{width:calc(100vw - 12px);height:calc(100dvh - 24px);border-radius:8px}}
      `;
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Lecture de la discussion Reddit');
      const frame = document.createElement('iframe');
      frame.title = 'Reddit Distill';
      frame.allow = 'clipboard-write';
      const token = crypto.randomUUID();
      const active = { host, dialog, frame, token, threadId, ready: false, authorized: false };
      session = active;
      dialog.append(frame);
      root.append(style, dialog);
      document.body.append(host);
      send({ action: 'registerReader', token, threadId: active.threadId }).then((response) => {
        if (session !== active || currentThread() !== active.threadId) {
          send({ action: 'unregisterReader', token, threadId: active.threadId }).catch(() => {});
          return;
        }
        if (!response?.ok) throw new Error('Impossible d’autoriser le lecteur.');
        const query = new URLSearchParams({ threadId: active.threadId, token, origin: location.origin });
        frame.src = chrome.runtime.getURL(`panel.html?${query}`);
      }).catch(() => {
        if (session !== active) return;
        const error = document.createElement('p');
        error.textContent = 'Impossible d’ouvrir Distill. Recharge cette discussion Reddit et l’extension.';
        error.style.cssText = 'padding:24px;font:16px system-ui';
        frame.replaceWith(error);
      });
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
      dialog.addEventListener('click', (event) => {
        const rect = dialog.getBoundingClientRect();
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) close();
      });
    }
    if (session.dialog.open) return;
    session.focus = document.activeElement;
    session.dialog.showModal();
    session.frame.focus();
    notifyOpen();
  }
  window.addEventListener('message', (event) => {
    if (!event.isTrusted || !session || currentThread() !== session.threadId || event.source !== session.frame.contentWindow || event.origin !== extensionOrigin || event.data?.token !== session.token) return;
    if (event.data.action === 'authorize' && typeof event.data.challenge === 'string') {
      const active = session;
      send({ action: 'authorizeReader', token: active.token, threadId: active.threadId, challenge: event.data.challenge }).then((response) => {
        if (!response?.ok || session !== active || currentThread() !== active.threadId) return;
        active.authorized = true;
        active.frame.contentWindow.postMessage({ action: 'authorized', token: active.token, challenge: event.data.challenge }, extensionOrigin);
      }).catch(() => {});
    }
    if (!session.authorized) return;
    if (event.data.action === 'ready') { session.ready = true; notifyOpen(); }
    if (event.data.action === 'close') close();
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.action === 'openReader') { open(); respond({ ok: Boolean(threadId) }); }
    if (['fetchRedditJson', 'collectPageComments', 'cancelRedditRequest'].includes(message?.action)) {
      syncPage();
      if (!session?.authorized || !session.dialog.open || message.token !== session.token || message.threadId !== session.threadId ||
          currentThread() !== session.threadId || typeof message.requestId !== 'string' || !requestIdPattern.test(message.requestId)) {
        respond({ ok: false, error: 'La discussion Reddit a changé. Rouvre Distill.' });
        return;
      }
      if (message.action === 'cancelRedditRequest') {
        // Cancellation can overtake the initial relay while the worker reads
        // session storage. Keep a small set of tombstones for that race.
        cancelledRequests.add(message.requestId);
        if (cancelledRequests.size > 256) cancelledRequests.delete(cancelledRequests.values().next().value);
        requests.get(message.requestId)?.abort();
        requests.delete(message.requestId);
        respond({ ok: true });
        return;
      }
      if (cancelledRequests.has(message.requestId)) {
        respond({ ok: false, aborted: true, error: 'Chargement Reddit annulé.' });
        return;
      }
      const running = requests.get(message.requestId);
      if (message.action === 'collectPageComments' && running?.collecting) {
        if (running.result) requests.delete(message.requestId);
        respond(running.result || { ok: true, collecting: true });
        return;
      }
      if (requests.has(message.requestId) || requests.size >= 8 || (message.action === 'collectPageComments' &&
          [...requests.values()].some((controller) => controller.collecting))) {
        respond({ ok: false, error: 'Un chargement Reddit est déjà en cours.' });
        return;
      }
      const controller = new AbortController();
      controller.collecting = message.action === 'collectPageComments';
      requests.set(message.requestId, controller);
      const pending = runRequest(message, session, controller);
      if (controller.collecting) {
        pending.then((result) => { if (requests.get(message.requestId) === controller) controller.result = result; });
        respond({ ok: true, collecting: true });
        return;
      }
      pending.then(respond);
      return true;
    }
    if (message?.action === 'readPageSnapshot') {
      syncPage();
      if (!session?.authorized || message.token !== session.token || message.threadId !== session.threadId || currentThread() !== session.threadId) {
        respond({ ok: false, error: 'La discussion Reddit a changé. Rouvre Distill.' });
        return;
      }
      try {
        const thread = globalThis.RedditDistillDOM.extractThread(document, location.href);
        respond(thread?.id === session.threadId ? { ok: true, thread } : { ok: false, error: 'Les commentaires de cette discussion ne sont pas encore disponibles.' });
      } catch {
        respond({ ok: false, error: 'Impossible de lire les commentaires visibles. Recharge la discussion Reddit.' });
      }
    }
  });
  function syncPage() {
    const next = currentThread();
    document.documentElement.classList.toggle('reddit-distill-focus', Boolean(next));
    if (next !== threadId) { destroy(); threadId = next; }
    if (!next) { button?.remove(); button = null; return; }
    // The post's action row lives in an open shadow root with no CSS part.
    // Retry during page sync: Reddit can attach or replace it after navigation.
    for (const post of document.querySelectorAll('shreddit-post')) {
      const root = post.shadowRoot;
      if (!root || root.getElementById('reddit-distill-focus-style')) continue;
      const style = document.createElement('style');
      style.id = 'reddit-distill-focus-style';
      style.textContent = ':host-context(html.reddit-distill-focus) [data-testid="action-row"] { display: none !important; }';
      root.append(style);
    }
    if (!button) {
      button = document.createElement('button');
      button.id = 'reddit-distill-button';
      button.type = 'button';
      button.textContent = 'Distill';
      button.title = 'Comprendre cette discussion Reddit';
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', (event) => { if (event.isTrusted) open(); });
    }
    if (document.body && !button.isConnected) document.body.append(button);
    if (session && !session.host.isConnected) destroy();
  }
  function scheduleSync() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; syncPage(); }, 80);
  }
  new MutationObserver(scheduleSync).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', syncPage);
  window.addEventListener('hashchange', syncPage);
  window.addEventListener('pageshow', syncPage);
  window.addEventListener('pagehide', destroy);
  // pushState in Reddit's page world cannot be wrapped from an isolated script.
  // Polling also covers same-document navigation without any DOM mutations.
  setInterval(syncPage, 750);
  syncPage();
})();
