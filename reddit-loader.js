// Explore Reddit's own comment controls in the signed-in page. This script
// never navigates the tab, submits a comment or clicks an unrelated action.
(() => {
  const COMMENT = 'shreddit-comment[thingid], shreddit-comment[comment-id], .thing.comment[data-fullname]';
  const SCOPE = 'shreddit-comment-tree,.commentarea';
  const MORE = /^(?:(?:load|show|view|see)\s+(?:\d+\s+)?more\s+(?:comments?|repl(?:y|ies))|(?:\d+\s+)?more\s+(?:comments?|repl(?:y|ies))|continue\s+(?:this\s+)?thread|(?:afficher|voir|charger)\s+(?:\d+\s+)?(?:plus|d[’']autres)\s+(?:de\s+)?(?:commentaires|réponses)|continuer\s+(?:ce|le)\s+fil)(?:\b|\s|$)/i;
  const EXPAND = /^(?:expand comment|expand thread|show comment|développer le commentaire|afficher le commentaire|développer les réponses)$/i;
  // The reader must start even when Reddit keeps offering overlapping branches.
  // Only a new comment buys more idle time, never another visited URL.
  const MAX_COMMENTS = 15000, MAX_TIME = 30000, MAX_IDLE_TIME = 5000, MAX_EMPTY_PAGES = 12;

  function threadAt(href) {
    try {
      const url = new URL(href, location.href);
      if (url.protocol !== 'https:' || url.port || !/^(?:(?:www|old|new)\.)?reddit\.com$/.test(url.hostname)) return '';
      const match = url.pathname.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i);
      return match ? `t3_${match[1].toLowerCase()}` : '';
    } catch { return ''; }
  }
  const abortError = () => new DOMException('La collecte Reddit a été interrompue.', 'AbortError');
  function parent(node) { return node?.parentElement || node?.getRootNode?.()?.host || null; }
  function closest(node, selector) {
    for (let next = node; next; next = parent(next)) if (next.matches?.(selector)) return next;
    return null;
  }
  function query(root, selector) {
    const result = [...root.querySelectorAll(selector)];
    // Comment components can put their disclosure button in an open shadow root.
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) result.push(...query(node.shadowRoot, selector));
    return result;
  }
  function hidden(node) {
    for (let next = node; next; next = parent(next)) {
      if (next.hidden || next.getAttribute?.('aria-hidden') === 'true' || next.getAttribute?.('slot') === 'loading') return true;
      if (next.style?.display === 'none' || next.style?.visibility === 'hidden') return true;
    }
    return false;
  }
  function hash(value) {
    let result = 0;
    for (let i = 0; i < value.length; i++) result = ((result << 5) - result + value.charCodeAt(i)) | 0;
    return result.toString(36);
  }
  function mergeComment(before, after) {
    if (!before) return after;
    // A continuation page may omit a parent that was visible in the full tree.
    const parentId = before.parent?.startsWith('t1_') && after.parent?.startsWith('t3_') ? before.parent : after.parent;
    const richer = !after.text && before.text ? before : after;
    return { ...before, ...richer, parent: parentId, links: richer.links || before.links || [] };
  }

  async function collect({ threadId, signal, onProgress, knownCommentIds = [], timeBudgetMs = MAX_TIME } = {}) {
    const expected = threadId || threadAt(location.href);
    if (!expected || expected !== threadAt(location.href)) throw abortError();
    const comments = new Map(), attempts = new Map(), pages = new Map(), seenIds = new Set(knownCommentIds);
    const deadline = Date.now() + Math.max(0, Math.min(MAX_TIME, timeBudgetMs));
    let emptyPages = 0;
    let snapshot, actions = 0, fetchedPages = 0, completedPages = 0, revision = 0, lastMutation = Date.now(), lastProgress = Date.now();
    let stopReason = '', observerError = null, captureQueued = false, finished = false;
    let savedScroll = null;
    const check = () => {
      if (signal?.aborted || threadAt(location.href) !== expected) throw abortError();
      if (observerError) throw observerError;
    };
    function progress(message, phase = 'collecting') {
      onProgress?.({ phase, loaded: seenIds.size, reported: snapshot?.coverage?.reported ?? null, actions, completedPages, message });
    }
    function accumulate(thread) {
      if (thread.id !== expected) throw abortError();
      let changed = false;
      for (const comment of thread.comments || []) {
        const previous = comments.get(comment.id);
        const next = mergeComment(previous, comment);
        if (!previous || previous.text !== next.text || previous.parent !== next.parent) changed = true;
        comments.set(comment.id, next);
        if (!seenIds.has(comment.id)) {
          seenIds.add(comment.id); lastProgress = Date.now(); emptyPages = 0;
        }
      }
      if (changed) revision++;
      return changed;
    }
    function capture() {
      check();
      const current = globalThis.RedditDistillDOM.extractThread(document, location.href);
      snapshot = current;
      if (accumulate(current)) progress(`${seenIds.size} commentaires récupérés ; exploration des réponses…`);
    }
    function delay(ms) {
      return new Promise((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(abortError()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    }
    async function settle(before) {
      const waitStarted = Date.now();
      do {
        await delay(150);
        capture();
        const elapsed = Date.now() - waitStarted;
        if (elapsed >= 300 && revision !== before && Date.now() - lastMutation >= 150) return;
        if (elapsed >= 1500) return;
      } while (Date.now() < deadline && Date.now() - lastProgress < MAX_IDLE_TIME);
    }
    function allowed(node) {
      const scope = closest(node, SCOPE);
      if (!scope) return false;
      for (const key of ['post-id', 'data-post-id', 'link-id', 'data-link-id']) {
        const owner = scope.getAttribute(key);
        if (owner && owner !== expected) return false;
      }
      const comment = closest(node, COMMENT);
      if (comment) return comments.has(comment.getAttribute('thingid') || comment.getAttribute('comment-id') || comment.getAttribute('data-fullname'));
      // Old Reddit and older Shreddit versions omit a thread id on the tree.
      // Reject scopes whose comments all belong to a stale SPA discussion.
      const descendants = [...scope.querySelectorAll(COMMENT)];
      return !descendants.length || descendants.some((item) => comments.has(item.getAttribute('thingid') || item.getAttribute('comment-id') || item.getAttribute('data-fullname')));
    }
    function continuation(href, base = location.href) {
      try {
        if (!href || /^\s*(?:#|javascript:)/i.test(href)) return null;
        const url = new URL(href, base);
        if (url.origin !== location.origin || threadAt(url.href) !== expected || /\.json(?:\/|$)/i.test(url.pathname)) return null;
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|share_|rdt|ref$|ref_source$)/.test(key)) url.searchParams.delete(key);
        return url.href;
      } catch { return null; }
    }
    function pageLinks(doc, base) {
      const found = [];
      for (const link of doc.querySelectorAll('a[slot="more-comments-permalink"][href],a.more-comments-link[href],.morecomments a[href],.morechildren a[href]')) {
        const href = continuation(link.getAttribute('href'), base);
        if (href && !hidden(link) && (doc !== document || allowed(link))) found.push(href);
      }
      return found;
    }
    function partialRequest(partial, base = location.href) {
      let url;
      try { url = new URL(partial.getAttribute('src'), base); } catch { return null; }
      // Only replay Reddit's read-only comment loader, never an arbitrary form
      // or endpoint from page markup. No credentials are read from the DOM.
      if (url.origin !== location.origin || !url.pathname.startsWith('/svc/shreddit/more-comments/') ||
          !url.pathname.split('/').includes(expected)) return null;
      const method = (partial.getAttribute('method') || 'get').toUpperCase();
      if (!['GET', 'POST'].includes(method)) return null;
      const cursor = partial.querySelector('input[name="cursor"]')?.value || '';
      const owner = closest(partial, COMMENT);
      const contextParent = owner?.getAttribute('thingid') || owner?.getAttribute('comment-id') || owner?.getAttribute('data-fullname');
      return { href: url.href, method, cursor, contextParent,
        key: `partial:${method}:${url.href}:${cursor}` };
    }
    function discover(doc, base, contextParent) {
      const keys = new Set();
      const add = (request) => {
        keys.add(request.key);
        if (!pages.has(request.key)) pages.set(request.key, { ...request, tries: 0, done: false });
      };
      for (const href of pageLinks(doc, base)) add({ key: href, href, method: 'GET' });
      for (const partial of query(doc, 'faceplate-partial[src]')) {
        if (hidden(partial) || (doc === document && !allowed(partial))) continue;
        const request = partialRequest(partial, base);
        if (request) add({ ...request, contextParent: request.contextParent || contextParent });
      }
      return keys;
    }
    function controls(root = document) {
      const result = [], seen = new Set();
      function add(node, kind, key) {
        if (!node || seen.has(node) || hidden(node) || !allowed(node)) return;
        seen.add(node);
        result.push({ node, kind, key, disabled: kind === 'pending' || node.disabled || node.getAttribute('aria-disabled') === 'true' });
      }
      for (const partial of query(root, 'faceplate-partial[src]')) {
        const request = partialRequest(partial);
        if (!request || pages.get(request.key)?.done) continue;
        const key = request.key;
        const button = [...partial.querySelectorAll('button[type="button"],button:not([type])')].find((item) => closest(item, 'faceplate-partial') === partial && !hidden(item) && !/^loading$/i.test(item.getAttribute('aria-label') || ''));
        if (button) add(button, 'click', key);
        else if (partial.getAttribute('loading') === 'lazy') add(partial, 'reveal', key);
        else if (partial.getAttribute('loading') === 'action') add(partial, 'pending', key);
      }
      for (const node of query(root, '.morecomments a,.morechildren a,a.morechildren,.morecomments button,.morechildren button,button,a[role="button"]')) {
        if (closest(node, 'faceplate-partial')) continue;
        const old = closest(node, '.morecomments,.morechildren');
        const label = (node.getAttribute('aria-label') || node.textContent || '').trim();
        if (!old && !MORE.test(label)) continue;
        if (node.matches('a[href]')) {
          const href = node.getAttribute('href').trim();
          if (continuation(href)) continue; // Fetch deep branches without navigation.
          if (href && href !== '#' && !/^javascript:\s*(?:void\s*\(\s*0\s*\)|\/\/)/i.test(href)) continue;
        }
        const owner = closest(node, COMMENT);
        const id = owner?.getAttribute('thingid') || owner?.getAttribute('data-fullname') || 'root';
        add(node, 'click', `more:${id}:${node.id || closest(node, '.morecomments,.morechildren')?.id || ''}:${hash(node.getAttribute('onclick') || label)}`);
      }
      for (const node of query(root, 'a.expand,button,[role="button"]')) {
        const comment = closest(node, COMMENT);
        if (!comment) continue;
        const label = (node.getAttribute('aria-label') || node.getAttribute('title') || '').trim();
        const old = node.matches('a.expand') && comment.classList.contains('collapsed');
        if (!old && !EXPAND.test(label)) continue;
        const id = comment.getAttribute('thingid') || comment.getAttribute('comment-id') || comment.getAttribute('data-fullname');
        add(node, 'click', `expand:${id}`);
      }
      return result;
    }
    async function fetchPage(task) {
      const { href, method, cursor, contextParent } = task;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, Math.min(8000, deadline - Date.now(), MAX_IDLE_TIME - (Date.now() - lastProgress))));
      try {
        check();
        const url = new URL(href);
        if (method === 'GET' && cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url.href, { method, ...(method === 'POST' ? { body: new URLSearchParams({ cursor }) } : {}),
          credentials: 'include', mode: 'same-origin', redirect: 'follow', signal: controller.signal, headers: { Accept: 'text/html' } });
        check();
        if (!response.ok) throw new Error(`Reddit : HTTP ${response.status}.`);
        if (response.url && response.url !== url.href && !continuation(response.url)) throw new Error('Reddit a renvoyé une autre page.');
        const body = await response.text();
        if (body.length > 8000000) throw new Error('La page Reddit dépasse la taille de lecture.');
        check();
        const doc = new DOMParser().parseFromString(body, 'text/html');
        // Reddit streams continuation trees inside <template for="…">. DOM
        // queries do not enter template.content, and detached pages never run
        // Reddit's hydration script. Unwrap these fragments only in this inert
        // document, including nested chunks, without executing page scripts.
        let template;
        while ((template = doc.querySelector('template[for],template[shadowrootmode]'))) {
          // A response consisting only of a template is parsed into <head>.
          if (template.closest('head')) { doc.body.append(template.content); template.remove(); }
          else template.replaceWith(template.content);
        }
        if (!doc.querySelector('shreddit-post,.thing.link[data-fullname]') && (doc.querySelector(COMMENT) ||
            [...doc.querySelectorAll('faceplate-partial[src]')].some((node) => partialRequest(node, href)))) {
          // Some continuation responses consist only of their comment branch.
          // The request URL proves its thread; explicit foreign comment ids are
          // still rejected by the DOM extractor's ancestry validation.
          const post = [...document.querySelectorAll('shreddit-post,.thing.link[data-fullname]')].find((node) => [node.getAttribute('post-id'), node.getAttribute('data-fullname'), node.id].includes(expected));
          if (post) {
            const scope = doc.createElement('shreddit-comment-tree');
            scope.setAttribute('post-id', expected);
            scope.append(...doc.body.childNodes);
            // Clone into the inert document: cloning in the live page would
            // run Reddit custom-element constructors before adoption.
            doc.body.append(doc.importNode(post, true), scope);
          }
        }
        const thread = globalThis.RedditDistillDOM.extractThread(doc, task.key.startsWith('partial:') ? location.href : href, { contextParent });
        const before = seenIds.size;
        accumulate(thread);
        if (seenIds.size === before) emptyPages++;
        const discovered = discover(doc, href, contextParent);
        fetchedPages++;
        // Repeated cursors are unresolved, not an invitation to fetch forever.
        // Known partials are queued above even in detached HTML; unsupported
        // native-only controls must still prevent a false complete claim.
        task.repeated = discovered.has(task.key);
        task.nativeControls = controls(doc).some((control) => !control.key.startsWith('partial:'));
        task.done = !task.repeated;
        if (task.done) completedPages++;
        progress(`${seenIds.size} commentaires récupérés ; lecture des branches profondes…`);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }

    capture();
    progress('Découverte automatique des commentaires et des réponses…');
    const observer = new MutationObserver(() => {
      lastMutation = Date.now();
      if (captureQueued) return;
      captureQueued = true;
      queueMicrotask(() => {
        captureQueued = false;
        if (finished) return;
        try { capture(); } catch (error) { observerError = error; }
      });
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      let idlePasses = 0;
      while (true) {
        capture();
        discover(document, location.href);
        if (comments.size >= MAX_COMMENTS || pages.size >= MAX_COMMENTS) { stopReason = 'La limite de sécurité de 15 000 commentaires ou branches a été atteinte.'; break; }
        if (Date.now() >= deadline) { stopReason = 'Le délai de collecte est atteint ; la lecture continue avec les commentaires récupérés.'; break; }
        if (Date.now() - lastProgress >= MAX_IDLE_TIME || emptyPages >= MAX_EMPTY_PAGES) { stopReason = 'Les dernières branches ne renvoient plus de nouveaux commentaires ; la lecture continue avec les commentaires récupérés.'; break; }
        // Fetch validated page-provided cursors directly. This also works when
        // the reader dialog makes the underlying page inert or a branch's HTML
        // has no running custom elements to handle its buttons.
        const available = controls();
        // When a direct request fails, try its live native control before
        // waiting on all the other pending requests.
        const fallback = available.find((control) => !control.disabled && (attempts.get(control.key) || 0) < 2 && pages.get(control.key)?.tries >= 2);
        const pending = [...pages.values()].filter((state) => !state.done && state.tries < 2);
        // Explore independent branches together, but keep native DOM actions
        // sequential. Fresh cursors go before retries and full HTML pages.
        pending.sort((a, b) => a.tries - b.tries || Number(b.key.startsWith('partial:')) - Number(a.key.startsWith('partial:')));
        if (!fallback && pending.length) {
          idlePasses = 0;
          const results = await Promise.allSettled(pending.slice(0, 3).map(async (task) => {
            task.tries++; actions++;
            try { await fetchPage(task); task.error = ''; }
            catch (error) { check(); task.error = error.message; emptyPages++; }
          }));
          const failed = results.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
          continue;
        }
        const next = fallback || available.find((control) => !control.disabled && (attempts.get(control.key) || 0) < 2);
        if (next) {
          idlePasses = 0;
          attempts.set(next.key, (attempts.get(next.key) || 0) + 1);
          actions++;
          const before = revision;
          progress(`Chargement automatique des réponses (${seenIds.size} commentaires récupérés)…`);
          if (next.kind === 'reveal') {
            if (!savedScroll) savedScroll = [window.scrollX, window.scrollY];
            next.node.scrollIntoView?.({ block: 'center', behavior: 'instant' });
          } else next.node.click();
          await settle(before);
          // A productive control can be reused (some Reddit versions keep the
          // same element and cursor). Only consecutive failures exhaust it.
          if (revision !== before) attempts.delete(next.key);
          const task = pages.get(next.key);
          if (task && !next.node.isConnected && revision !== before) { task.done = true; task.error = ''; }
          continue;
        }
        // Leave time for a pending native lazy loader or Reddit hydration to
        // expose another branch before declaring the visible tree exhausted.
        if (idlePasses++ < (available.some((control) => control.disabled) ? 6 : 2)) { await delay(400); continue; }
        break;
      }
      capture();
      const detachedLoaders = [...pages.values()].some((state) => state.nativeControls);
      const unresolved = controls().length > 0 || detachedLoaders || [...pages.values()].some((state) => !state.done);
      const reported = snapshot.coverage?.reported ?? null;
      const connected = new Set([expected]);
      const missingParents = [...comments.keys()].some((id) => {
        const branch = new Set();
        let next = id;
        while (!connected.has(next)) {
          if (branch.has(next) || !comments.has(next)) return true;
          branch.add(next);
          next = comments.get(next).parent;
        }
        for (const parentId of branch) connected.add(parentId);
        return false;
      });
      const exhausted = !stopReason && !unresolved;
      const complete = exhausted && !missingParents && reported !== null && comments.size >= reported;
      let reason = '', diagnostic = '';
      if (!complete) {
        reason = stopReason || (missingParents ? 'Certains commentaires parents ne sont pas accessibles dans les branches renvoyées par Reddit.'
          : detachedLoaders ? 'Certains chargements de branches Reddit restent incomplets après l’exploration automatique.'
          : unresolved ? 'Reddit n’a pas terminé certains chargements malgré les nouvelles tentatives automatiques.'
            : 'Toutes les branches accessibles ont été explorées automatiquement.');
        const failures = [...new Set([...pages.values()].filter((state) => !state.done).map((state) => state.error || (state.repeated ? 'Reddit a renvoyé le même curseur de pagination.' : '')).filter(Boolean))];
        if (failures.length) reason += ` ${failures.join(' ')}`;
        diagnostic = reason;
        if (reported !== null && comments.size < reported) reason += ` ${comments.size} commentaires récupérés sur ${reported} annoncés par Reddit.`;
        if (reported === null) reason += ' Reddit ne fournit pas de total vérifiable.';
      }
      const result = { ...snapshot, comments: [...comments.values()], coverage: { source: 'page-auto', loaded: comments.size, reported,
        complete, exhausted, reason, diagnostic, actions, fetchedPages, unresolved: [...pages.values()].filter((state) => !state.done).length } };
      progress(complete ? 'Tous les commentaires annoncés ont été récupérés.' : reason, 'complete');
      return result;
    } finally {
      finished = true;
      observer.disconnect();
      if (savedScroll && threadAt(location.href) === expected) window.scrollTo?.(...savedScroll);
    }
  }
  globalThis.RedditDistillLoader = Object.freeze({ collect });
})();
