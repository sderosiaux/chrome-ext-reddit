// Kept identical in the YouTube and HN extensions. No generated HTML, SVG or JS
// is executed: the model describes a small graph, and we draw trusted elements.
export const DIAGRAM_INSTRUCTIONS = `Le lecteur apprend visuellement : les schémas font partie de l'explication. Évalue séparément chaque section et chaque mécanisme développé. Ajoute un schéma dès qu'il rend plus facile à suivre un enchaînement d'étapes, un routage avec plusieurs issues, des interactions, des dépendances, une boucle de retour, une hiérarchie ou les liens entre arguments et objections, à condition que ces relations soient explicites dans les sources. Cela vaut pour les sujets techniques comme pour les raisonnements, débats et récits.
Un premier schéma ne couvre pas les autres mécanismes du contenu. Il n'y a ni quota global ni obligation par section : plusieurs sections peuvent chacune bénéficier d'un schéma, et une section peut en contenir plusieurs si elle explique des mécanismes distincts. En lecture détaillée ou approfondie, couvre visuellement les mécanismes qui s'y prêtent tout au long du contenu. En lecture courte, privilégie les mécanismes essentiels à l'aperçu. Une simple liste de faits, une opinion isolée ou une relation déjà illustrée n'appelle pas de nouveau schéma ; la longueur d'une section ne suffit pas à le justifier.
Insère chaque schéma immédiatement APRÈS le paragraphe qui explique le mécanisme concerné, puis poursuis les notes normalement. En Q/R, il se place dans la réponse concernée. Si la sortie est un objet JSON, le bloc diagram appartient à la chaîne answer ou text : n'ajoute aucun champ ni bloc hors de cet objet. Le texte doit rester compréhensible sans le schéma. Les objectifs de longueur en mots ou en phrases concernent la prose, pas le JSON des schémas ; garde chaque schéma compact.
Avant de terminer, vérifie silencieusement que les sections suivantes ne restent pas uniquement textuelles par oubli alors qu'elles expliquent un autre mécanisme qui gagnerait à être visualisé. N'affiche ni cette vérification ni les raisons d'inclure ou d'omettre un schéma.
Écris le schéma dans un bloc de code de langage diagram, contenant uniquement du JSON de cette forme :
\`\`\`diagram
{"title":"Titre descriptif","nodes":[{"id":"a","label":"Information reçue"},{"id":"b","label":"Décision"},{"id":"c","label":"Action"}],"edges":[{"from":"a","to":"b","label":""},{"from":"b","to":"c","label":"condition"}]}
\`\`\`
Cet exemple décrit le format, pas un contenu à recopier. Choisis les libellés dans la langue des notes. Utilise des identifiants simples, des libellés courts (80 caractères maximum par nœud, 40 par lien), au plus 10 nœuds et 16 liens par schéma. Une flèche exprime uniquement la relation indiquée ; nomme les liens non séquentiels (conteste, dépend de, illustre…) pour ne pas suggérer une causalité inventée. Conserve les conditions, attributions et incertitudes de la source, y compris dans le schéma. N'invente aucune étape pour compléter un workflow. Les références restent dans le paragraphe associé. Aucun HTML, SVG brut, lien, style ou code exécutable dans un schéma.`;

const clean = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  ? value.replace(/\s+/g, ' ').trim() : null;
export function normalizeDiagram(value) {
  if (!value || !clean(value.title, 160) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) ||
      value.nodes.length < 2 || value.nodes.length > 10 || !value.edges.length || value.edges.length > 16) return null;
  const ids = new Set(), nodes = [], edges = [];
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-zA-Z][\w-]{0,23}$/.test(node.id) ||
        ids.has(node.id) || !clean(node.label, 80)) return null;
    ids.add(node.id); nodes.push({ id: node.id, label: clean(node.label, 80) });
  }
  for (const edge of value.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) ||
        (edge.label != null && (typeof edge.label !== 'string' || edge.label.length > 40))) return null;
    edges.push({ from: edge.from, to: edge.to, label: clean(edge.label, 40) || '' });
  }
  return { title: clean(value.title, 160), nodes, edges };
}

// Recognize whole fenced blocks; an unfinished diagram never flashes as raw JSON
// during streaming. Other fenced code (including examples containing fences) stays intact.
export function splitDiagrams(text) {
  const parts = [];
  let pending = '', fence = null, content = [];
  for (const line of String(text || '').match(/[^\n]*\n|[^\n]+$/g) || []) {
    if (!fence) {
      const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
      if (!match) { pending += line; continue; }
      fence = { marker: match[1][0], length: match[1].length, diagram: match[2].trim() === 'diagram' };
      content = [line];
    } else {
      content.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
      if (!close || close[1][0] !== fence.marker || close[1].length < fence.length) continue;
      if (fence.diagram) {
        if (pending) parts.push({ type: 'text', text: pending });
        pending = '';
        let diagram = null;
        const raw = content.slice(1, -1).join('');
        try { if (raw.length <= 12_000) diagram = normalizeDiagram(JSON.parse(raw)); } catch { /* Keep the surrounding prose. */ }
        parts.push({ type: 'diagram', diagram });
      } else pending += content.join('');
      fence = null; content = [];
    }
  }
  if (fence && !fence.diagram) pending += content.join('');
  if (pending) parts.push({ type: 'text', text: pending });
  return parts;
}

export function diagramDescription(diagram) {
  const labels = new Map(diagram.nodes.map(n => [n.id, n.label]));
  return diagram.edges.map(e => `${labels.get(e.from)} ${e.label ? `— ${e.label} →` : '→'} ${labels.get(e.to)}`);
}

const markdownText = text => text.replace(/[\\`*_{}\[\]()#+!<>|]/g, '\\$&');
// Entity-escape punctuation in Mermaid strings, and generate our own identifiers.
// Model text can never become a directive, link or second Mermaid statement.
const mermaidLabel = text => Array.from(text).map(c => /[\p{L}\p{N} ,.?éàèù-]/u.test(c) ? c : `#${c.codePointAt(0)};`).join('');
export function diagramMarkdown(diagram) {
  const ids = new Map(diagram.nodes.map((n, i) => [n.id, `n${i}`]));
  return `${markdownText(diagram.title)}\n\n\`\`\`mermaid\nflowchart TD\n` +
    diagram.nodes.map(n => `  ${ids.get(n.id)}["${mermaidLabel(n.label)}"]`).join('\n') + '\n' +
    diagram.edges.map(e => `  ${ids.get(e.from)} -->${e.label ? `|"${mermaidLabel(e.label)}"|` : ''} ${ids.get(e.to)}`).join('\n') + '\n```';
}
export function exportDiagrams(text, format = 'markdown') {
  return splitDiagrams(text).map(part => {
    if (part.type === 'text') return part.text;
    if (!part.diagram) return '';
    return '\n\n' + (format === 'text'
      ? `${part.diagram.title}\n${diagramDescription(part.diagram).map(line => `- ${line}`).join('\n')}`
      : diagramMarkdown(part.diagram)) + '\n\n';
  }).join('');
}

export function readableDiagramText(container) {
  const copy = container.cloneNode(true);
  copy.removeAttribute('id'); copy.hidden = false;
  copy.classList.add('diagram-copy'); copy.setAttribute('aria-hidden', 'true');
  for (const figure of copy.querySelectorAll('.inline-diagram')) {
    const description = document.createElement('p');
    description.textContent = `${figure.querySelector('figcaption').textContent}\n${figure.querySelector('desc').textContent}`;
    figure.replaceWith(description);
  }
  document.body.append(copy);
  try { return copy.innerText; } finally { copy.remove(); }
}

function layout(diagram) {
  const outgoing = new Map(diagram.nodes.map(n => [n.id, []]));
  diagram.edges.forEach((e, i) => outgoing.get(e.from).push({ ...e, index: i }));
  const visited = new Set(), visiting = new Set(), feedback = new Set(), order = [];
  // Ignore feedback edges only for ranking; they are still drawn in separate lanes.
  const visit = id => {
    if (visited.has(id)) return;
    visited.add(id); visiting.add(id);
    for (const edge of outgoing.get(id)) {
      if (visiting.has(edge.to)) feedback.add(edge.index);
      else visit(edge.to);
    }
    visiting.delete(id); order.unshift(id);
  };
  diagram.nodes.forEach(n => visit(n.id));
  const rank = new Map(diagram.nodes.map(n => [n.id, 0]));
  for (const id of order) for (const edge of outgoing.get(id))
    if (!feedback.has(edge.index)) rank.set(edge.to, Math.max(rank.get(edge.to), rank.get(id) + 1));
  const rows = [];
  for (const node of diagram.nodes) (rows[rank.get(node.id)] ||= []).push(node);
  const linear = !feedback.size && diagram.nodes.length <= 4 && rows.every(row => row.length === 1) &&
    diagram.edges.length === diagram.nodes.length - 1 && diagram.edges.every(e => !e.label);
  const context = document.createElement('canvas').getContext('2d');
  if (context) context.font = '500 14px system-ui';
  const measure = text => context ? context.measureText(text).width : Array.from(text).length * 9;
  const wrap = (text, width) => {
    const lines = []; let line = '';
    for (const word of text.split(' ')) {
      if (line && measure(line + word) > width) { lines.push(line); line = ''; }
      for (const char of word) {
        if (measure(line + char) > width) { lines.push(line); line = ''; }
        line += char;
      }
      line += ' ';
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  };
  const width = linear ? 156 : 180, gap = 28, positions = new Map();
  let y = 16;
  const columns = Math.max(...rows.map(r => r.length));
  const graphWidth = linear ? rows.length * (width + gap) - gap : columns * (width + gap) - gap;
  rows.forEach((row, rowIndex) => {
    const boxes = row.map(node => ({ ...node, lines: wrap(node.label, width - 24) }));
    const height = Math.max(56, ...boxes.map(n => n.lines.length * 20 + 24));
    boxes.forEach((node, i) => positions.set(node.id, {
      ...node, x: 16 + (linear ? rowIndex * (width + gap) : (graphWidth - row.length * (width + gap) + gap) / 2 + i * (width + gap)),
      y: linear ? 16 : y, width, height, rank: rowIndex,
    }));
    y += height + 76;
  });
  if (linear) {
    const height = Math.max(...[...positions.values()].map(n => n.height));
    for (const node of positions.values()) node.height = height;
  }
  let lane = 0;
  const edges = diagram.edges.map((edge, index) => {
    const a = positions.get(edge.from), b = positions.get(edge.to);
    if (linear) return { ...edge, path: `M ${a.x + width} ${a.y + a.height / 2} H ${b.x}`, label: '' };
    if (feedback.has(index) || b.rank !== a.rank + 1) {
      const x = 16 + graphWidth + 70 + lane++ * 110;
      const exit = Math.max(...[...positions.values()].filter(n => n.rank === a.rank).map(n => n.y + n.height)) + 24;
      const entry = b.y - 12;
      return { ...edge, path: `M ${a.x + width / 2} ${a.y + a.height} V ${exit} H ${x} V ${entry} H ${b.x + width / 2} V ${b.y}`,
        labelX: x, labelY: (exit + entry) / 2 };
    }
    const sx = a.x + width / 2, tx = b.x + width / 2, sy = a.y + a.height, ty = b.y;
    const middle = sy + (ty - sy) / 2;
    const incoming = diagram.edges.filter(e => e.to === b.id).length;
    return { ...edge, path: `M ${sx} ${sy} V ${middle} H ${tx} V ${ty}`,
      labelX: incoming > 1 ? sx : tx, labelY: middle };
  });
  edges.forEach(edge => { edge.lines = wrap(edge.label, 100); });
  return { nodes: [...positions.values()], edges, width: graphWidth + 32 + (lane ? lane * 110 + 30 : 0),
    height: linear ? Math.max(...[...positions.values()].map(n => n.height)) + 32 : y - 76 + 40 };
}

let serial = 0;
const diagramKeys = new WeakMap();
export function renderDiagram(value, previous = null) {
  const diagram = normalizeDiagram(value);
  if (!diagram) return null;
  const key = JSON.stringify(diagram);
  if (previous && diagramKeys.get(previous) === key) return previous;
  const geometry = layout(diagram), id = `diagram-${++serial}`;
  const svgNode = (tag, attributes = {}, text) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const figure = document.createElement('figure'); figure.className = 'inline-diagram';
  const caption = document.createElement('figcaption'); caption.textContent = diagram.title;
  const viewport = document.createElement('div'); viewport.className = 'diagram-viewport';
  viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', diagram.title);
  const svg = svgNode('svg', { viewBox: `0 0 ${geometry.width} ${geometry.height}`, width: geometry.width,
    height: geometry.height, role: 'img', 'aria-labelledby': `${id}-title ${id}-description` });
  svg.append(svgNode('title', { id: `${id}-title` }, diagram.title),
    svgNode('desc', { id: `${id}-description` }, diagramDescription(diagram).join('. ')));
  const defs = svgNode('defs'), marker = svgNode('marker', { id: `${id}-arrow`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.append(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 Z', class: 'diagram-arrow' }));
  defs.append(marker); svg.append(defs);
  for (const edge of geometry.edges) svg.append(svgNode('path', { d: edge.path, class: 'diagram-edge', 'marker-end': `url(#${id}-arrow)` }));
  for (const edge of geometry.edges) if (edge.label) {
    const height = edge.lines.length * 16 + 8;
    svg.append(svgNode('rect', { x: edge.labelX - 54, y: edge.labelY - height / 2, width: 108, height, rx: 4, class: 'diagram-label-bg' }));
    const text = svgNode('text', { class: 'diagram-edge-label', 'text-anchor': 'middle' });
    edge.lines.forEach((line, i) => text.append(svgNode('tspan', { x: edge.labelX, y: edge.labelY - (edge.lines.length - 1) * 8 + i * 16 + 4 }, line.trim())));
    svg.append(text);
  }
  for (const node of geometry.nodes) {
    svg.append(svgNode('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: 7, class: 'diagram-node' }));
    const text = svgNode('text', { class: 'diagram-node-label', 'text-anchor': 'middle' });
    node.lines.forEach((line, i) => text.append(svgNode('tspan', { x: node.x + node.width / 2,
      y: node.y + node.height / 2 - (node.lines.length - 1) * 10 + i * 20 + 5 }, line.trim())));
    svg.append(text);
  }
  viewport.append(svg); figure.append(caption, viewport);
  diagramKeys.set(figure, key);
  return figure;
}
