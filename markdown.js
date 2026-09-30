import { sourceMap } from './data.js';
import { kindLabel, sourceUrl, coverageText } from './render.js';
import { splitDiagrams, diagramMarkdown, diagramDescription } from './diagrams.js';

const escape = (text) => String(text).replace(/[\\`*_{}\[\]()#+!<>|]/g, '\\$&');
export function generateMarkdown(thread, analysis, { format = 'markdown', language = 'fr', partial = false } = {}) {
  const md = format === 'markdown';
  const plain = (s) => md ? escape(s) : s;
  const heading = (level, text) => `${md ? '#'.repeat(level) + ' ' : ''}${plain(text)}`;
  const sources = sourceMap(thread);
  const permalink = sourceUrl(thread, thread);
  const out = [heading(1, thread.title), `${md ? '[Reddit](' + permalink + ')' : permalink}`];
  if (thread.subreddit) out.push(plain(`r/${thread.subreddit}`));
  const coverage = coverageText(thread, language);
  if (coverage) out.push(plain(coverage));
  if (partial) out.push(language === 'fr' ? 'Notes incomplètes — génération interrompue.' : 'Incomplete notes — generation interrupted.');
  if (!analysis) {
    for (const item of [thread, ...thread.comments]) {
      if (!item.text) continue;
      out.push(heading(2, item.author ? `u/${item.author}` : String(item.id)), plain(item.text), sourceUrl(item, thread));
    }
  } else {
    for (const section of analysis.sections) {
      out.push(heading(2, section.title));
      for (const entry of section.entries) {
        if (entry.title) out.push(heading(3, entry.title));
        const kind = kindLabel(entry.kind, language);
        const body = splitDiagrams(entry.text).map(part => {
          if (part.type === 'text') return plain(part.text.trim());
          if (!part.diagram) return '';
          return md ? diagramMarkdown(part.diagram) :
            `${part.diagram.title}\n${diagramDescription(part.diagram).map(line => `- ${line}`).join('\n')}`;
        }).filter(Boolean).join('\n\n');
        out.push((kind ? `${plain(kind)} — ` : '') + body);
        out.push(entry.sources.map((id) => {
          const source = sources.get(id);
          const author = source?.author ? `u/${source.author}` : id;
          const url = sourceUrl(source || { id }, thread);
          return md ? `[${escape(author)}](${url})` : `${author}: ${url}`;
        }).join(' · '));
      }
    }
  }
  return out.join('\n\n') + '\n';
}
