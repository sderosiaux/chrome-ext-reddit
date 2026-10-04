import { cacheKey, readCache } from './storage.js';
import { validateAnalysis } from './analysis.js';
import { sourceMap } from './data.js';
import { sourceUrl } from './render.js';
import { generateMarkdown } from './markdown.js';
import { buildArchiveDocument, selectCompletedSummary } from './github-archive.js';

export async function summaryArchive({ thread, settings, views }) {
  const sources = sourceMap(thread);
  const { detail, result } = await selectCompletedSummary(async depth => {
    if (depth === 'detailed') return null;
    const key = await cacheKey(thread, { ...settings, detail: depth }, 'summary');
    const view = views.get(key);
    const candidate = view?.complete && !view.provisional ? view.result : await readCache(key);
    if (!candidate) return null;
    try { return validateAnalysis(candidate, sources, 'summary'); }
    catch { return null; }
  });
  return buildArchiveDocument({ medium: 'reddit', id: thread.id, title: thread.title,
    url: sourceUrl(thread, thread), detail, language: settings.language,
    markdown: generateMarkdown(thread, result, { language: settings.language }),
  });
}
