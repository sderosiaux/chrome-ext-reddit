import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisSchema, validateAnalysis, partialAnalysis, AnalysisError } from '../analysis.js';
import { buildRedditAnalysisPrompt } from '../prompts.js';
import { generateMarkdown } from '../markdown.js';
import { sourceUrl } from '../render.js';

const thread = {
  id: 't3_1wo8160', title: 'A difficult decision', subreddit: 'ExperiencedDevs', author: 'op', text: 'An ethical question.',
  permalink: 'https://www.reddit.com/r/ExperiencedDevs/comments/1wo8160/a_difficult_decision/',
  coverage: { complete: false, loaded: 1, reported: 42, source: 'page', reason: 'Seuls les messages chargés dans la page sont disponibles.' },
  comments: [{ id: 't1_abc12', parent: 't3_1wo8160', author: 'dev', text: 'One experience.',
    permalink: 'https://www.reddit.com/r/ExperiencedDevs/comments/1wo8160/a_difficult_decision/abc12/' }],
};
const sources = new Map([[thread.id, thread], ...thread.comments.map((comment) => [comment.id, comment])]);
const entry = { kind: 'experience', title: 'An experience', text: 'This is an individual experience.', sources: ['t1_abc12'] };
const analysis = (entries = [entry]) => ({ sections: [{ title: 'Perspectives', entries }] });

test('schema and validation retain exact Reddit fullnames and reject invented citations', () => {
  const schema = analysisSchema();
  const reference = schema.properties.sections.items.properties.entries.items.properties.sources.items;
  assert.equal(reference.type, 'string');
  assert.deepEqual(validateAnalysis(analysis(), sources), analysis());
  for (const invalid of [123, 'abc12', 't1_missing', 't3_abc12', 't1_ABC12']) {
    assert.throws(() => validateAnalysis(analysis([{ ...entry, sources: [invalid] }]), sources), AnalysisError);
  }
  const duplicate = validateAnalysis(analysis([{ ...entry, sources: ['t1_abc12', 't1_abc12'] }]), sources);
  assert.deepEqual(duplicate.sections[0].entries[0].sources, ['t1_abc12']);
});

test('unfinished JSON exposes only complete entries, even with braces and escaped quotes', () => {
  const completed = { ...entry, text: 'Un avis {entre accolades}, « exact » et "cité".' };
  const text = `{"sections":[{"title":"Perspectives","entries":[${JSON.stringify(completed)},{"kind":"argument","text":"inachevé`;
  assert.deepEqual(validateAnalysis(partialAnalysis(text), sources, 'summary', { preview: true }), analysis([completed]));
});

test('invalid citation is excluded from previews and final validation preserves valid passages', () => {
  const value = analysis([entry, { ...entry, text: 'Unknown source', sources: ['t1_missing'] }]);
  assert.deepEqual(validateAnalysis(value, sources, 'summary', { preview: true }), analysis());
  assert.throws(() => validateAnalysis(value, sources), (error) => {
    assert.deepEqual(error.partial, analysis());
    return true;
  });
});

test('Q&A requires both a question and its answer; duplicated answers do not become complete notes', () => {
  assert.throws(() => validateAnalysis(analysis(), sources, 'qa'), /question/);
  assert.throws(() => validateAnalysis(analysis([{ ...entry, kind: 'question', title: '', text: 'Answer' }]), sources, 'qa'), /question/);
  const long = { ...entry, text: 'An individual account must remain an individual account, and its limits need to remain visible when the source contains them.' };
  assert.throws(() => validateAnalysis(analysis([long, long]), sources), (error) => error.code === 'repetition');
});

test('prompt includes subreddit and honest coverage in direct and intermediate analysis', () => {
  for (const evidence of [false, true]) {
    const prompt = buildRedditAnalysisPrompt(thread, { language: 'fr', detail: 'deep' }, 'summary', { comments: thread.comments }, evidence);
    const input = JSON.parse(prompt.input);
    assert.equal(input.subreddit, 'ExperiencedDevs');
    assert.deepEqual(input.coverage, thread.coverage);
    assert.equal(input.post_id, thread.id);
    assert.match(prompt.instructions, /votes et scores ne prouvent/);
    assert.match(prompt.instructions, /génération interrompue/);
    assert.doesNotMatch(prompt.instructions, /Hacker News|numériques sources/);
  }
});

test('source URLs accept only the cited Reddit post/comment and fall back for spoofed permalinks', () => {
  const comment = thread.comments[0];
  assert.equal(sourceUrl(comment, thread), comment.permalink);
  for (const permalink of [
    'https://www.reddit.com.evil.test/r/dev/comments/1wo8160/topic/abc12/',
    'https://www.reddit.com/r/dev/comments/1wo8160/topic/other/',
    'https://www.reddit.com/r/dev/comments/other/topic/abc12/',
    'javascript:alert(1)',
  ]) {
    assert.equal(sourceUrl({ ...comment, permalink }, thread), 'https://www.reddit.com/comments/1wo8160/_/abc12/');
  }
});

test('exports distinguish partial collection from interrupted generation and retain exact comment links', () => {
  const markdown = generateMarkdown(thread, analysis(), { partial: true });
  assert.match(markdown, /Discussion partiellement récupérée/);
  assert.match(markdown, /1 \/ 42 commentaires/);
  assert.match(markdown, /Notes incomplètes — génération interrompue/);
  assert.ok(markdown.includes(thread.comments[0].permalink));
  assert.ok(markdown.includes('r/ExperiencedDevs'));
  const complete = generateMarkdown({ ...thread, coverage: { ...thread.coverage, complete: true } }, analysis());
  assert.doesNotMatch(complete, /partiellement|interrompue/);
});
