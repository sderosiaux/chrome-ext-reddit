// Runs as a classic content script. It only reads the page already open to the
// user; no hidden endpoints, credentials or privileged page state are inspected.
(() => {
  const COMMENT = 'shreddit-comment[thingid], shreddit-comment[comment-id], .thing.comment[data-fullname]';
  const FULLNAME = /^(?:t1|t3)_[a-z0-9]+$/;
  const cleanAuthor = (value) => value === '[deleted]' ? '' : String(value || '').replace(/^u\//, '');
  function linkUrl(value, base) {
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  function permalink(value, fallback) {
    const url = linkUrl(value || fallback, 'https://www.reddit.com');
    return url && /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com\//.test(url) ? url : fallback;
  }
  function own(node, selector) {
    return [...node.querySelectorAll(selector)].find((candidate) => candidate.closest(COMMENT) === node) || null;
  }
  function content(node, base) {
    if (!node) return { text: '', links: [], unavailable: true };
    const copy = node.cloneNode(true);
    copy.querySelectorAll('script,style,iframe,object,button,shreddit-comment,.thing.comment').forEach((el) => el.remove());
    const links = [...copy.querySelectorAll('a[href]')].map((a) => ({
      url: linkUrl(a.getAttribute('href'), base), label: a.textContent.trim(),
    })).filter((link) => link.url);
    copy.querySelectorAll('p,div,li,pre,blockquote,br').forEach((el) => el.prepend('\n'));
    const text = copy.textContent.replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const unavailable = !text || /^\[(?:removed|deleted)\]$/i.test(text);
    return { text: unavailable ? '' : text, links: unavailable ? [] : links, unavailable };
  }
  function attr(node, ...names) {
    for (const name of names) if (node?.getAttribute?.(name)) return node.getAttribute(name);
    return '';
  }
  function nameOf(node) {
    const value = attr(node, 'thingid', 'comment-id', 'data-fullname');
    return /^t1_[a-z0-9]+$/.test(value) ? value : '';
  }
  function threadOfLink(value) {
    const href = linkUrl(value, 'https://www.reddit.com');
    if (!href || !/^https:\/\/(?:www\.|old\.|new\.)?reddit\.com\//.test(href)) return '';
    const match = new URL(href).pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
    return match ? `t3_${match[1].toLowerCase()}` : '';
  }
  function threadOfContainer(node) {
    const value = attr(node, 'post-id', 'data-post-id', 'link-id', 'data-link-id', 'data-fullname', 'thingid');
    return /^t3_[a-z0-9]+$/.test(value) ? value : threadOfLink(attr(node, 'permalink'));
  }

  function extractThread(doc = document, href = location.href, { contextParent } = {}) {
    const url = new URL(href);
    if (!/^https:\/\/(?:www\.|old\.|new\.)?reddit\.com$/.test(url.origin))
      throw new Error('Cette page n’est pas une discussion Reddit.');
    const match = url.pathname.match(/\/(?:comments)\/([a-z0-9]+)(?:\/|$)/i);
    if (!match) throw new Error('Aucune discussion Reddit dans cette page.');
    const bareId = match[1].toLowerCase(), id = `t3_${bareId}`;
    const fallback = `https://www.reddit.com/comments/${bareId}/`;
    const post = [...doc.querySelectorAll('shreddit-post,.thing.link[data-fullname]')].find((node) =>
      [attr(node, 'post-id'), attr(node, 'data-fullname'), node.id].includes(id));
    // A stale SPA page must never be attributed to the newly requested URL.
    if (!post) throw new Error('Le contenu de cette discussion n’est pas encore chargé dans Reddit.');
    const modern = post.tagName.toLowerCase() === 'shreddit-post';
    const title = attr(post, 'post-title') || post.querySelector(modern ? 'h1,[slot="title"]' : 'a.title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim();
    if (!title) throw new Error('Le titre de cette discussion n’est pas encore disponible.');
    const postBody = post.querySelector(modern ? '[slot="text-body"], [id$="-post-rtjson-content"]' : '.usertext-body .md');
    const postContent = content(postBody, url.href);
    const postLink = permalink(attr(post, 'permalink') || post.querySelector('a.comments')?.getAttribute('href'), fallback);
    const subreddit = (attr(post, 'subreddit-prefixed-name', 'subreddit-name', 'data-subreddit') || url.pathname.match(/^\/r\/([^/]+)/i)?.[1] || '').replace(/^r\//i, '');
    const count = attr(post, 'comment-count', 'data-comments-count');
    const countText = post.querySelector('a.comments')?.textContent || '';
    const exactCount = count || countText.match(/^\s*([\d,]+)\s+(?:comments?|commentaires?)/i)?.[1]?.replace(/,/g, '');
    const reported = /^\d+$/.test(exactCount || '') && Number.isSafeInteger(Number(exactCount)) ? Number(exactCount) : null;
    const comments = new Map(), candidates = new Map(), depthsByScope = new Map();
    // Build the complete visible graph before assigning comments to this post.
    // SPA transitions may leave an older tree first in DOM order, and a foreign
    // parent can appear after its children in a flattened comment list.
    for (const node of doc.querySelectorAll(COMMENT)) {
      const commentId = nameOf(node);
      if (!commentId) continue;
      const scope = node.closest('shreddit-comment-tree,.commentarea') || doc;
      if (!depthsByScope.has(scope)) depthsByScope.set(scope, new Map());
      const byDepth = depthsByScope.get(scope);
      const parentNode = node.parentElement?.closest(COMMENT);
      const declaredParent = attr(node, 'parentid', 'parent-id', 'data-parent-fullname');
      const depth = Number(attr(node, 'depth'));
      const commentLink = own(node, 'a[slot="permalink"], a.bylink, a[data-testid="comment_timestamp"]');
      const rawPermalink = attr(node, 'permalink') || commentLink?.getAttribute('href');
      const ownThread = threadOfContainer(node) || threadOfLink(rawPermalink);
      const scopeThread = threadOfContainer(scope) || threadOfContainer(scope.parentElement?.closest('shreddit-post,.thing.link[data-fullname]'));
      const parent = FULLNAME.test(declaredParent) ? declaredParent : nameOf(parentNode) ||
        (depth > 0 ? byDepth.get(depth - 1) || (/^t1_[a-z0-9]+$/.test(contextParent || '') ? contextParent : null) : null) || ownThread || scopeThread || id;
      const candidate = { node, commentId, parent, physicalParent: nameOf(parentNode), ownThread, scopeThread, rawPermalink };
      // Prefer an explicitly matching copy if Reddit temporarily duplicates a
      // comment during navigation; unrelated nodes are still available as
      // ancestry evidence for descendants.
      if (!candidates.has(commentId) || (ownThread === id && scopeThread !== '' && scopeThread === id)) candidates.set(commentId, candidate);
      byDepth.set(depth, commentId);
      for (const key of byDepth.keys()) if (key > depth) byDepth.delete(key);
    }
    function belongsToPost(candidate) {
      const stack = [candidate.commentId], visited = new Set();
      let proven = false;
      while (stack.length) {
        const name = stack.pop();
        if (visited.has(name)) continue;
        visited.add(name);
        if (name.startsWith('t3_')) { if (name !== id) return false; proven = true; continue; }
        const current = candidates.get(name);
        if (!current) continue;
        for (const owner of [current.ownThread, current.scopeThread]) {
          if (owner && owner !== id) return false;
          if (owner === id) proven = true;
        }
        stack.push(current.parent);
        if (current.physicalParent) stack.push(current.physicalParent);
      }
      return proven;
    }
    for (const candidate of candidates.values()) {
      if (!belongsToPost(candidate)) continue;
      const { node, commentId, parent, rawPermalink } = candidate;
      const body = own(node, '[slot="comment"], [data-testid="comment"], .usertext-body .md, .md');
      const parsed = content(body, url.href);
      const authorLink = own(node, 'a.author, a[href^="/user/"], a[href^="/u/"]');
      const scoreValue = attr(node, 'score', 'data-score');
      comments.set(commentId, {
        id: commentId, parent, author: cleanAuthor(attr(node, 'author', 'author-name', 'data-author') || authorLink?.textContent?.trim()),
        ...parsed,
        permalink: permalink(rawPermalink, `https://www.reddit.com/comments/${bareId}/_/${commentId.slice(3)}/`),
        score: /^-?\d+$/.test(scoreValue) ? Number(scoreValue) : null,
      });
    }
    const external = attr(post, 'content-href') || (!modern ? post.querySelector('a.title')?.getAttribute('href') : null);
    const externalUrl = external ? linkUrl(external, url.href) : null;
    const isOwnThread = externalUrl && new URL(externalUrl).hostname.endsWith('reddit.com') && new URL(externalUrl).pathname.includes(`/comments/${bareId}`);
    return {
      id, title, author: cleanAuthor(attr(post, 'author', 'data-author') || post.querySelector('a.author')?.textContent?.trim()),
      text: postContent.text, links: postContent.links, subreddit, permalink: postLink,
      url: isOwnThread ? null : externalUrl, comments: [...comments.values()],
      coverage: {
        complete: false, loaded: comments.size, reported, source: 'page',
        reason: 'Certains commentaires restent inaccessibles après la tentative de chargement automatique.',
      },
    };
  }
  globalThis.RedditDistillDOM = Object.freeze({ extractThread });
})();
