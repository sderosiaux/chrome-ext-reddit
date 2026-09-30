export const PROMPT_VERSION = 'reddit-2026-09-30.1';
const string = { type: 'string' };
// Simple patterns and minItems: 1 are supported by both providers. No question cap.
const nonEmptyString = { type: 'string', pattern: '[^\\s]' };
export const ENTRY_KINDS = ['explanation', 'argument', 'objection', 'experience', 'inference', 'definition', 'question', 'open_question'];
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export function analysisSchema(mode = 'summary') {
  return object({ sections: { type: 'array', minItems: 1, items: object({
    title: nonEmptyString,
    entries: { type: 'array', minItems: 1, items: object({
      kind: { type: 'string', enum: mode === 'qa' ? ['question'] : ENTRY_KINDS },
      title: mode === 'qa' ? { ...nonEmptyString, description: 'La question complète, jamais vide.' } : string,
      text: { ...nonEmptyString, description: mode === 'qa' ? 'La réponse à cette question, jamais vide. Aucun titre ou autre question dans ce champ.' : 'Le contenu de cette explication, jamais vide.' },
      sources: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^t[13]_[a-z0-9]+$' } },
    }) },
  }) } });
}
export const ANALYSIS_SCHEMA = analysisSchema();

export class AnalysisError extends Error {
  constructor(message, partial, code = 'structure') {
    super(message); this.name = 'AnalysisError'; this.partial = partial; this.code = code;
  }
}
export function validateEntry(entry, sources) {
  if (!entry || typeof entry !== 'object') throw new Error('passage illisible');
  // Some providers occasionally capitalize enums. Normalize casing, never invent content.
  const kind = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : entry.kind;
  if (!ENTRY_KINDS.includes(kind)) throw new Error('type de passage non reconnu');
  if (typeof entry.title !== 'string') throw new Error('titre manquant');
  if (typeof entry.text !== 'string' || !entry.text.trim()) throw new Error('texte de réponse manquant');
  if (!Array.isArray(entry.sources)) throw new Error('références manquantes');
  if (!entry.sources.length || entry.sources.some((id) => typeof id !== 'string' || !/^t[13]_[a-z0-9]+$/.test(id) || !sources.has(id)))
    throw new Error('référence absente des commentaires fournis');
  return { ...entry, kind, sources: [...new Set(entry.sources)] };
}
const normalize = (text) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function validateAnalysis(value, sources, mode = 'summary', { preview = false } = {}) {
  const result = { sections: [] }, seen = new Set(), questions = new Set(), errors = [];
  if (!value || !Array.isArray(value.sections)) {
    if (preview) return result;
    throw new AnalysisError('La réponse ne contient pas les sections attendues.', result);
  }
  let index = 0;
  for (const section of value.sections) {
    if (!section || typeof section.title !== 'string' || !Array.isArray(section.entries)) {
      errors.push('Une section est illisible.'); continue;
    }
    if (!section.title.trim()) errors.push('Une section ne contient pas de titre.');
    if (!section.entries.length) errors.push('Une section ne contient aucune explication.');
    const valid = { title: section.title, entries: [] };
    result.sections.push(valid);
    for (const item of section.entries) {
      index++;
      let entry;
      try {
        entry = validateEntry(item, sources);
        if (mode === 'qa' && (entry.kind !== 'question' || !entry.title.trim())) throw new Error('question manquante ou non reconnue');
      } catch (error) {
        errors.push(`${mode === 'qa' ? 'Réponse' : 'Passage'} ${index} : ${error.message}.`);
        continue;
      }
      const key = normalize(entry.text);
      const question = normalize(entry.title);
      if ((key.length > 100 && seen.has(key)) || (mode === 'qa' && question && questions.has(question)))
        throw new AnalysisError('La génération se répète. Les passages déjà reçus sont conservés.', { sections: result.sections.filter((s) => s.entries.length) }, 'repetition');
      seen.add(key); questions.add(question); valid.entries.push(entry);
    }
  }
  result.sections = result.sections.filter((s) => s.entries.length);
  // Streaming previews include only safe, complete entries. Final validation still
  // reports any missing/invalid passage, and never caches a partial answer as complete.
  if (!preview && errors.length) throw new AnalysisError(
    `${errors[0]}${result.sections.length ? ' Les passages valides restent disponibles.' : ''}`, result,
  );
  if (!preview && !result.sections.length) throw new AnalysisError('Aucune explication exploitable dans la réponse.', result);
  return result;
}

// Extract only complete JSON entries from an unfinished stream.
export function partialAnalysis(text) {
  const sections = [];
  let section = null, start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      depth++;
      if (depth === 2) {
        const match = text.slice(i).match(/^\{\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")/);
        section = { title: match ? JSON.parse(match[1]) : '', entries: [] };
        sections.push(section);
      }
      if (depth === 3) start = i;
    }
    if (char === '}') {
      if (depth === 3 && start >= 0 && section) {
        try { section.entries.push(JSON.parse(text.slice(start, i + 1))); } catch { /* wait for valid data */ }
        start = -1;
      }
      depth--;
    }
  }
  return { sections: sections.filter((s) => s.entries.length) };
}
