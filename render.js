import { sourceMap, threadUrl, safeUrl } from './data.js';
import { splitDiagrams, renderDiagram } from './diagrams.js';

// Source links must remain Reddit permalinks for the exact cited item. External
// links from a post/comment use safeUrl separately and are never source links.
export function sourceUrl(source, thread) {
  try {
    const url = new URL(source.permalink, 'https://www.reddit.com');
    const match = url.pathname.match(/^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/[^/]+(?:\/([a-z0-9]+))?)?\/?$/i);
    const postId = String(thread?.id || (source.id?.startsWith('t3_') ? source.id : '')).replace(/^t3_/, '');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com'].includes(url.hostname) && match &&
        (!postId || match[1] === postId) &&
        (source.id === `t3_${match[1]}` && !match[2] || source.id === `t1_${match[2]}`))
      return `${url.origin}${url.pathname}`;
  } catch { /* Missing or malformed permalinks use the canonical fallback. */ }
  return threadUrl(source.id, thread?.id);
}

export function coverageText(thread, language = 'fr') {
  const coverage = thread.coverage;
  if (coverage?.complete === true) return '';
  const loaded = Number.isSafeInteger(coverage?.loaded) ? coverage.loaded : thread.comments.length;
  const reported = Number.isSafeInteger(coverage?.reported) ? coverage.reported : null;
  const count = reported === null ? `${loaded}` : `${loaded} / ${reported}`;
  const reason = typeof coverage?.reason === 'string' ? coverage.reason.trim() : '';
  return language === 'fr'
    ? `Discussion partiellement récupérée : ${count} commentaires. L’analyse porte uniquement sur les messages disponibles.${reason ? ` ${reason}` : ''}`
    : `Discussion partially retrieved: ${count} comments. This analysis covers only the available messages.${reason ? ` ${reason}` : ''}`;
}

export const kindLabel = (kind, language = 'fr') => {
  const labels = {
    fr: { inference: 'Interprétation', experience: 'Témoignage', objection: 'Objection', definition: 'Notion', open_question: 'Question ouverte' },
    en: { inference: 'Interpretation', experience: 'Experience', objection: 'Objection', definition: 'Concept', open_question: 'Open question' },
    es: { inference: 'Interpretación', experience: 'Experiencia', objection: 'Objeción', definition: 'Concepto', open_question: 'Pregunta abierta' },
    de: { inference: 'Interpretation', experience: 'Erfahrung', objection: 'Einwand', definition: 'Begriff', open_question: 'Offene Frage' },
    pt: { inference: 'Interpretação', experience: 'Experiência', objection: 'Objeção', definition: 'Conceito', open_question: 'Questão aberta' },
    zh: { inference: '推断', experience: '个人经历', objection: '异议', definition: '概念', open_question: '开放问题' },
    ja: { inference: '解釈', experience: '体験', objection: '反論', definition: '概念', open_question: '未解決の問い' },
  };
  return (labels[language] || labels.en)[kind] || '';
};

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(text, url) {
  const a = element('a', text);
  a.href = safeUrl(url) || 'https://www.reddit.com/';
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}
function paragraphs(container, text) {
  for (const part of splitDiagrams(text)) {
    if (part.type === 'diagram') {
      const figure = renderDiagram(part.diagram);
      if (figure) container.append(figure);
    } else {
      for (const paragraph of part.text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean))
        container.append(element('p', paragraph));
    }
  }
}

function sourceComment(comment, sources, thread, ancestors = new Set()) {
  const article = element('div', '', 'source-comment');
  article.lang = ''; // Original comments need not match the language of generated notes.
  const header = element('div', '', 'source-header');
  const permalink = sourceUrl(comment, thread);
  header.append(link(comment.author ? `u/${comment.author}` : 'Message', permalink), link('Ouvrir sur Reddit ↗', permalink));
  article.append(header);
  if (comment.parent && sources.has(comment.parent) && !ancestors.has(comment.parent)) {
    const parent = sources.get(comment.parent);
    const details = element('details', '', 'parent-context');
    details.append(element('summary', `En réponse à ${parent.author ? `u/${parent.author}` : 'un message'}`));
    details.addEventListener('toggle', () => {
      if (!details.open || details.childElementCount > 1) return;
      details.append(sourceComment(parent, sources, thread, new Set([...ancestors, comment.id])));
    });
    article.append(details);
  }
  const text = comment.id === thread.id && comment.title ? [comment.title, comment.text].filter(Boolean).join('\n\n') : comment.text;
  article.append(element('div', text || (comment.unavailable ? 'Commentaire supprimé ou inaccessible.' : 'Aucun texte dans ce message.'), 'source-text'));
  const links = element('div', '', 'source-links');
  for (const source of comment.links || []) if (safeUrl(source.url)) links.append(link(source.label || source.url, source.url));
  if (links.childElementCount) article.append(links);
  return article;
}

function entryNode(entry, sources, language, thread) {
  const node = element('div', '', 'entry');
  const label = kindLabel(entry.kind, language);
  if (label || entry.title) {
    const heading = element('h3');
    if (label) heading.append(element('span', label + (entry.title ? ' : ' : ''), 'entry-kind'));
    heading.append(entry.title);
    node.append(heading);
  }
  paragraphs(node, entry.text);
  const details = element('details', '', 'source-disclosure');
  details.lang = 'fr';
  details.append(element('summary', `Sources · ${entry.sources.length}`));
  details.addEventListener('toggle', () => {
    if (!details.open || details.childElementCount > 1) return;
    const body = element('div', '', 'source-body');
    for (const id of entry.sources) if (sources.has(id)) body.append(sourceComment(sources.get(id), sources, thread));
    details.append(body);
  });
  node.append(details);
  return node;
}

export function createRenderer(container) {
  let rendered = [];
  const reset = () => { container.replaceChildren(); rendered = []; };
  return {
    reset,
    analysis(result, thread, language) {
      container.lang = language;
      const sources = sourceMap(thread);
      for (let i = 0; i < result.sections.length; i++) {
        const section = result.sections[i];
        if (!rendered[i]) {
          const node = element('section');
          const title = element('h2', section.title);
          node.append(title); container.append(node);
          rendered[i] = { node, title, entries: [] };
        }
        const mounted = rendered[i];
        mounted.title.textContent = section.title;
        for (let j = 0; j < section.entries.length; j++) {
          const entry = section.entries[j], signature = JSON.stringify(entry);
          if (mounted.entries[j]?.signature === signature) continue;
          const node = entryNode(entry, sources, language, thread);
          if (mounted.entries[j]) mounted.entries[j].node.replaceWith(node);
          else mounted.node.append(node);
          mounted.entries[j] = { node, signature };
        }
        while (mounted.entries.length > section.entries.length) mounted.entries.pop().node.remove();
      }
      while (rendered.length > result.sections.length) rendered.pop().node.remove();
    },
    discussion(thread) {
      reset(); container.lang = 'fr';
      const sources = sourceMap(thread);
      const intro = element('div', '', 'discussion-intro');
      intro.append(element('p', `${thread.subreddit ? `r/${thread.subreddit} · ` : ''}${thread.comments.filter((c) => c.text).length} commentaires lisibles. Les réponses conservent leur contexte.`));
      if (thread.url) {
        const p = element('p', 'L’analyse porte sur la discussion. L’article externe n’a pas été lu. ');
        p.append(link('Ouvrir l’article ↗', thread.url)); intro.append(p);
      }
      container.append(intro);
      container.append(sourceComment(sources.get(thread.id), sources, thread));
      for (const c of thread.comments) {
        const details = element('details', '', 'source-disclosure');
        details.append(element('summary', `${c.author ? `u/${c.author}` : 'Commentaire'} · ${c.text ? c.text.slice(0, 105).replace(/\s+/g, ' ') + (c.text.length > 105 ? '…' : '') : 'Supprimé ou inaccessible'}`));
        details.addEventListener('toggle', () => {
          if (details.open && details.childElementCount === 1) {
            const body = element('div', '', 'source-body');
            body.append(sourceComment(c, sources, thread)); details.append(body);
          }
        });
        container.append(details);
      }
    },
  };
}
