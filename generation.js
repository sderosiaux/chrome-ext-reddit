import { partitionThread, sourceMap } from './data.js';
import { buildRedditAnalysisPrompt } from './prompts.js';
import { generate } from './api_client.js';
import { AnalysisError, partialAnalysis, validateAnalysis } from './analysis.js';

const encoder = new TextEncoder();
const bytes = (text) => encoder.encode(text).length;
const jsonBytes = (value) => bytes(JSON.stringify(value));
const promptBytes = (prompt) => bytes(prompt.input) + bytes(prompt.instructions);

export async function analyzeThread({ thread, settings, mode, signal = new AbortController().signal, onProgress = () => {}, onPartial = () => {} }) {
  signal.throwIfAborted();
  const all = sourceMap(thread);
  // Use the same actual UTF-8 bound for direct, preparatory, reduction and final
  // requests. Fixed instructions/context recur in every call, not just the first.
  const requestBudget = settings.provider === 'claude' ? 100_000 : 300_000;
  const promptFor = (input, evidence = false) => buildRedditAnalysisPrompt(thread, settings, mode, input, evidence);
  const overhead = Math.max(promptBytes(promptFor({})), promptBytes(promptFor({}, true)));
  const payloadBudget = requestBudget - overhead - 512; // Reserve JSON envelope/rounding room.
  if (payloadBudget < 1024)
    throw new Error('Le contexte personnel est trop volumineux pour ce modèle. Réduis-le dans les paramètres avant de relancer.');
  const partitionBudget = Math.min(payloadBudget, settings.provider === 'claude' ? 100_000 : 160_000);
  const direct = { comments: [...all.values()].filter((c) => c.text || (c.id === thread.id && thread.title)).map((c) => ({
    id: c.id, parent: c.parent || null, author: c.author, text: c.text,
    ...(c.id === thread.id ? { title: thread.title } : {}),
  })) };
  if (!direct.comments.length) throw new Error('Cette discussion ne contient pas encore de texte à analyser.');
  const directPrompt = promptFor(direct);
  // Measure the actual payload, including instructions and reader context. Reserving
  // space for nonexistent ancestor excerpts caused ordinary threads to be split.
  // UTF-8 bytes are a conservative token upper bound; leave room for model output.
  const directBytes = promptBytes(directPrompt);
  const finalLabel = mode === 'qa' ? 'Rédaction des questions-réponses' : 'Rédaction de la synthèse';
  const run = async (input, evidence, sources, { label = finalLabel, prefix = [], preview = true } = {}) => {
    let last = 0;
    const outputMode = evidence ? 'summary' : mode;
    const prompt = promptFor(input, evidence);
    if (promptBytes(prompt) > requestBudget)
      throw new Error('Ce passage dépasse le budget du modèle. Réduis le contexte personnel ou choisis une lecture plus concise. Aucun appel supplémentaire n’a été envoyé.');
    onProgress(`${label} · en attente du modèle…`);
    try {
      const text = await generate({ settings, signal, mode: outputMode,
        prompt,
        onDelta: (text) => {
          if (Date.now() - last < 180) return;
          last = Date.now();
          const valid = validateAnalysis(partialAnalysis(text), sources, outputMode, { preview: true });
          const count = valid.sections.reduce((n, s) => n + s.entries.length, 0);
          onProgress(count ? `${label} · ${count} ${mode === 'qa' && !evidence ? 'réponses' : 'idées'} reçues` : `${label} · le modèle rédige…`);
          if (count) {
            if (preview) onPartial({ sections: [...prefix, ...valid.sections] }, { provisional: evidence });
          }
        },
      });
      signal.throwIfAborted();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch {
        const lastValid = validateAnalysis(partialAnalysis(text), sources, outputMode, { preview: true });
        throw new AnalysisError('La réponse s’est terminée avec un document incomplet.' +
          (lastValid.sections.length ? ' Les passages valides restent disponibles.' : ''), lastValid);
      }
      return validateAnalysis(parsed, sources, outputMode);
    } catch (error) {
      // Provider interruptions carry raw output; keep every complete, cited entry,
      // including deltas that arrived inside the preview throttle window.
      if (!error.partial && error.partialText) {
        try { error.partial = validateAnalysis(partialAnalysis(error.partialText), sources, outputMode, { preview: true }); }
        catch (validationError) { error.partial = validationError.partial; }
      }
      if (evidence && error.partial) {
        error.partial = preview ? { sections: [...prefix, ...error.partial.sections] } : null;
        error.provisional = true;
      }
      throw error;
    }
  };
  if (directBytes <= requestBudget) return run(direct, false, new Map(direct.comments.map((c) => [c.id, c])));
  const parts = partitionThread(thread, partitionBudget);

  let notes = [];
  for (let i = 0; i < parts.length; i++) {
    const sources = new Map([...parts[i].comments, ...parts[i].context].map((c) => [c.id, c]));
    const result = await run(parts[i], true, sources, {
      label: `Notes provisoires · lecture ${i + 1}/${parts.length}`, prefix: notes,
    });
    notes.push(...result.sections);
    onPartial({ sections: [...notes] }, { provisional: true });
  }
  // Hierarchical reduction has a strict progress condition, never a fixed question/comment cap.
  while (promptBytes(promptFor({ evidence_notes: notes })) > requestBudget) {
    const before = jsonBytes(notes);
    const groups = [];
    const envelope = jsonBytes({ evidence_notes: [] });
    let group = [], size = envelope;
    for (const section of notes) for (const entry of section.entries) {
      const item = { title: section.title, entries: [entry] };
      const length = jsonBytes(item);
      if (length + envelope > payloadBudget) throw new Error('Une note intermédiaire est trop longue. Réessaie avec une lecture plus concise.');
      if (size + length + (group.length ? 1 : 0) > payloadBudget && group.length) { groups.push(group); group = []; size = envelope; }
      size += length + (group.length ? 1 : 0); group.push(item);
    }
    if (group.length) groups.push(group);
    const reduced = [];
    for (let i = 0; i < groups.length; i++) {
      const ids = new Set(groups[i].flatMap((s) => s.entries.flatMap((e) => e.sources)));
      const result = await run({ evidence_notes: groups[i] }, true, new Map([...ids].map((id) => [id, all.get(id)])), {
        label: `Mise en relation des arguments · ${i + 1}/${groups.length}`, preview: false,
      });
      reduced.push(...result.sections);
    }
    if (jsonBytes(reduced) >= before * .9) throw new Error('La synthèse ne se compacte plus. Arrêt pour éviter une boucle ; aucun commentaire récupéré n’a été écarté de la lecture.');
    notes = reduced;
  }
  const ids = new Set(notes.flatMap((s) => s.entries.flatMap((e) => e.sources)));
  return run({ evidence_notes: notes }, false, new Map([...ids].map((id) => [id, all.get(id)])));
}
