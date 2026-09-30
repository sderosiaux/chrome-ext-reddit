import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeThread } from '../generation.js';
import { generate, readEvents } from '../api_client.js';

const settings = { provider: 'openai', apiKey: 'test-key', language: 'fr', detail: 'short', personalContext: '' };
const thread = {
  id: 't3_abc', title: 'Question', author: 'op', subreddit: 'test', text: 'Question initiale.',
  comments: [{ id: 't1_def', parent: 't3_abc', author: 'reader', text: 'An experience.' }],
  coverage: { complete: true, loaded: 1, reported: 1, source: 'json', reason: '' },
};
const result = (id = 't1_def', text = 'An individual experience.') => ({ sections: [{ title: 'Perspectives', entries: [
  { kind: 'experience', title: 'Experience', text, sources: [id] },
] }] });
function stream(events, split = false) {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(data);
  return new ReadableStream({ start(controller) {
    if (split) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
    else controller.enqueue(bytes);
    controller.close();
  } });
}
function completed(value) {
  return new Response(stream([{ type: 'response.completed', response: { status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
  ] } }]), { status: 200 });
}
function providerReply(value, provider) {
  return provider === 'claude' ? new Response(stream([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(value) } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]), { status: 200 }) : completed(value);
}
function requestContents(options) {
  const body = JSON.parse(options.body);
  const instructions = body.instructions || body.system;
  const input = body.input?.[0].content || body.messages[0].content;
  return { instructions, input: JSON.parse(input), bytes: new TextEncoder().encode(instructions + input).length };
}
function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

test('SSE decoder handles fragmented UTF-8 and CRLF', async () => {
  const events = [{ type: 'response.output_text.delta', delta: 'Éthique 🧭' }, { type: 'other' }];
  const actual = [];
  for await (const event of readEvents(stream(events, true))) actual.push(event);
  assert.deepEqual(actual, events);
});

test('a title-only post remains a valid source', async (t) => {
  const titleOnly = { ...thread, text: '', comments: [] };
  mockFetch(t, async (_, options) => {
    const input = JSON.parse(JSON.parse(options.body).input[0].content);
    assert.equal(input.comments[0].id, titleOnly.id);
    assert.equal(input.comments[0].title, titleOnly.title);
    return completed(result(titleOnly.id));
  });
  assert.deepEqual(await analyzeThread({ thread: titleOnly, settings, mode: 'summary' }), result(titleOnly.id));
});

test('direct generation sends fullnames, coverage and the Reddit output schema', async (t) => {
  mockFetch(t, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.input[0].content);
    assert.equal(body.store, false);
    assert.equal(body.text.format.name, 'reddit_discussion');
    assert.equal(input.comments[1].id, 't1_def');
    assert.equal(input.comments[1].parent, 't3_abc');
    assert.deepEqual(input.coverage, thread.coverage);
    return completed(result());
  });
  assert.deepEqual(await analyzeThread({ thread, settings, mode: 'summary' }), result());
});

test('stream interruptions preserve complete cited entries, including the final throttled delta', async (t) => {
  const value = result();
  const json = JSON.stringify(value);
  mockFetch(t, async () => new Response(stream([
    { type: 'response.output_text.delta', delta: json.slice(0, 20) },
    { type: 'response.output_text.delta', delta: json.slice(20) },
  ]), { status: 200 }));
  await assert.rejects(analyzeThread({ thread, settings, mode: 'summary' }), (error) => {
    assert.match(error.message, /interrompue/);
    assert.deepEqual(error.partial, value);
    return true;
  });
});

test('completed provider response with unknown source never validates as complete', async (t) => {
  mockFetch(t, async () => completed(result('t1_nonexistent')));
  await assert.rejects(analyzeThread({ thread, settings, mode: 'summary' }), /référence absente/);
});

test('provider errors during streaming do not silently retry a paid generation', async (t) => {
  let requests = 0;
  mockFetch(t, async () => {
    requests++;
    return new Response(stream([{ type: 'error', error: { message: 'Upstream failed' } }]), { status: 200 });
  });
  await assert.rejects(generate({ settings, prompt: { instructions: '', input: '' }, signal: new AbortController().signal }), /Upstream failed/);
  assert.equal(requests, 1);
});

test('large discussions send every collected comment through preparatory notes before final synthesis', async (t) => {
  const large = { ...thread, comments: Array.from({ length: 5 }, (_, index) => ({
    id: `t1_c${index}`, parent: thread.id, author: `reader${index}`, text: `${index} ${'x'.repeat(75_000)}`,
  })) };
  const seen = new Set();
  let requests = 0, finalCalls = 0;
  mockFetch(t, async (_, options) => {
    const input = JSON.parse(JSON.parse(options.body).input[0].content);
    requests++;
    if (input.evidence_notes) {
      finalCalls++;
      const id = input.evidence_notes[0].entries[0].sources[0];
      return completed(result(id, 'The final synthesis is grounded in the collected notes.'));
    }
    for (const comment of input.comments) seen.add(comment.id);
    return completed(result(input.comments[0].id, `Preparatory finding ${requests}.`));
  });
  const output = await analyzeThread({ thread: large, settings, mode: 'summary' });
  for (const comment of large.comments) assert.ok(seen.has(comment.id), `${comment.id} was omitted`);
  assert.equal(finalCalls, 1);
  assert.ok(requests > 2);
  assert.match(output.sections[0].entries[0].text, /final synthesis/);
});

for (const provider of ['openai', 'claude']) {
  test(`${provider}: CJK/emoji discussions reserve repeated personal context and keep every request within its UTF-8 budget`, async (t) => {
    const configured = { ...settings, provider, personalContext: 'Mon expérience 🧭 '.repeat(1000) };
    const large = { ...thread, comments: Array.from({ length: 6 }, (_, index) => ({
      id: `t1_c${index}`, parent: thread.id, author: `reader${index}`, text: `${index} ${'漢🧭'.repeat(12000)}`,
    })) };
    const received = new Map();
    let requests = 0, finals = 0;
    mockFetch(t, async (_, options) => {
      const request = requestContents(options);
      assert.ok(request.bytes <= (provider === 'claude' ? 100_000 : 300_000), `${request.bytes} UTF-8 bytes sent`);
      assert.equal(request.input.reader_context, configured.personalContext);
      requests++;
      if (request.input.evidence_notes) {
        finals++;
        return providerReply(result(request.input.evidence_notes[0].entries[0].sources[0], 'Final Unicode synthesis.'), provider);
      }
      for (const comment of request.input.comments)
        received.set(comment.id, (received.get(comment.id) || '') + comment.text);
      return providerReply(result(request.input.comments[0].id, `Unicode finding ${requests}.`), provider);
    });
    await analyzeThread({ thread: large, settings: configured, mode: 'summary' });
    assert.ok(requests > 2);
    assert.equal(finals, 1);
    for (const comment of large.comments) assert.equal(received.get(comment.id), comment.text);
  });

  test(`${provider}: oversized personal context is rejected before any paid request`, async (t) => {
    let requests = 0;
    mockFetch(t, async () => { requests++; return completed(result()); });
    await assert.rejects(analyzeThread({ thread, settings: { ...settings, provider, personalContext: '漢🧭'.repeat(50_000) }, mode: 'summary' }), /contexte personnel.*trop volumineux/);
    assert.equal(requests, 0);
  });
}

test('Unicode evidence notes are reduced using real final-prompt bytes, including personal context', async (t) => {
  const configured = { ...settings, provider: 'claude', personalContext: 'é'.repeat(15_000) };
  const large = { ...thread, comments: Array.from({ length: 6 }, (_, index) => ({
    id: `t1_c${index}`, parent: thread.id, author: `reader${index}`, text: `${index} ${'漢🧭'.repeat(12000)}`,
  })) };
  let requests = 0, reductions = 0, finals = 0;
  mockFetch(t, async (_, options) => {
    const { input, instructions, bytes } = requestContents(options);
    assert.ok(bytes <= 100_000, `${bytes} bytes sent to Claude`);
    requests++;
    if (input.evidence_notes) {
      if (instructions.includes('Cette étape prépare des notes')) reductions++;
      else finals++;
      return providerReply(result(input.evidence_notes[0].entries[0].sources[0], `Reduced finding ${requests}.`), 'claude');
    }
    return providerReply(result(input.comments[0].id, `${requests}: ${'漢🧭'.repeat(1800)}`), 'claude');
  });
  await analyzeThread({ thread: large, settings: configured, mode: 'summary' });
  assert.ok(reductions > 0, 'large Unicode notes must trigger reduction');
  assert.equal(finals, 1);
});
