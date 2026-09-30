import { analysisSchema } from './analysis.js';

export const MODELS = { openai: 'gpt-6-luna', claude: 'claude-sonnet-4-5' };
export class GenerationError extends Error {
  constructor(message, partial = '') { super(message); this.partialText = partial; }
}

export async function* readEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const decode = (frame) => frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const data = decode(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
    }
    const tail = decode(buffer.trim());
    if (tail && tail !== '[DONE]') yield JSON.parse(tail);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function generate({ settings, prompt, signal, mode = 'summary', onDelta = () => {} }) {
  const claude = settings.provider === 'claude';
  const schema = analysisSchema(mode);
  const key = settings.apiKey;
  if (!key) throw new Error('Ajoute une clé API dans les paramètres.');
  const body = claude ? {
    model: MODELS.claude, stream: true, max_tokens: 64000,
    system: prompt.instructions, messages: [{ role: 'user', content: prompt.input }],
    output_config: { format: { type: 'json_schema', schema } },
  } : {
    model: MODELS.openai, stream: true, store: false, reasoning: { effort: 'none' },
    instructions: prompt.instructions, input: [{ role: 'user', content: prompt.input }],
    text: { format: { type: 'json_schema', name: mode === 'qa' ? 'reddit_questions' : 'reddit_discussion', strict: true, schema } },
  };
  const timeout = new AbortController();
  const combined = AbortSignal.any([signal, timeout.signal]);
  let timer, text = '', stopReason;
  // Inactivity timeout: long, productive generations are allowed to finish.
  const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => timeout.abort(), 90_000); };
  resetTimeout();
  try {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      combined.throwIfAborted();
      response = await fetch(claude ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses', {
        method: 'POST', signal: combined,
        headers: { 'Content-Type': 'application/json', ...(claude ? {
          'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
        } : { Authorization: `Bearer ${key}` }) }, body: JSON.stringify(body),
      });
      if (response.ok) break;
      const data = await response.json().catch(() => ({}));
      const exhausted = data.error?.code === 'insufficient_quota';
      if (attempt < 2 && ((response.status === 429 && !exhausted) || response.status >= 500)) {
        const seconds = Number(response.headers.get('retry-after'));
        await delay(Math.min(10_000, seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt), combined);
        resetTimeout(); continue;
      }
      if (response.status === 401 || response.status === 403) throw new Error('Clé API ou accès au modèle refusé. Vérifie les paramètres.');
      if (exhausted) throw new Error('Crédit API épuisé. Vérifie la facturation du fournisseur.');
      throw new Error(data.error?.message || `Le fournisseur a refusé la requête (HTTP ${response.status}).`);
    }
    if (!response.body) throw new Error('Réponse vide du fournisseur.');
    for await (const event of readEvents(response.body)) {
      combined.throwIfAborted();
      if (event.type === 'response.output_text.delta' || (event.type === 'content_block_delta' && event.delta?.type === 'text_delta')) {
        const delta = claude ? event.delta.text : event.delta || '';
        if (delta.trim()) resetTimeout();
        text += delta;
        onDelta(text);
      } else if (event.type === 'message_delta') stopReason = event.delta?.stop_reason;
      else if (event.type?.startsWith('response.refusal') || (event.type === 'message_stop' && stopReason === 'refusal')) {
        throw new GenerationError('Le modèle n’a pas pu analyser ce contenu.', text);
      } else if (event.type === 'response.incomplete' || (event.type === 'message_stop' && stopReason !== 'end_turn')) {
        throw new GenerationError('La réponse est incomplète. Les passages reçus sont conservés.', text);
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw new GenerationError(event.error?.message || event.response?.error?.message || 'La génération a échoué.', text);
      } else if (event.type === 'response.completed' || event.type === 'message_stop') {
        if (!claude) {
          if (event.response?.status !== 'completed') throw new GenerationError('Réponse incomplète.', text);
          const output = (event.response.output || []).flatMap((item) => item.type === 'message' ? item.content || [] : []);
          if (output.some((item) => item.type === 'refusal')) throw new GenerationError('Le modèle a refusé cette analyse.', text);
          text = output.filter((item) => item.type === 'output_text').map((item) => item.text).join('') || text;
        }
        if (!text.trim()) throw new Error('Le modèle a renvoyé une réponse vide.');
        onDelta(text);
        return text;
      }
    }
    throw new GenerationError('Connexion interrompue avant la fin de la réponse.', text);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (timeout.signal.aborted) throw new GenerationError('Le fournisseur ne répond plus. Les passages reçus sont conservés.', text);
    throw error;
  } finally { clearTimeout(timer); }
}
