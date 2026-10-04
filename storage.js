import { PROMPT_VERSION } from './analysis.js';
import { MODELS } from './api_client.js';

let ready;
export function initializeStorage() {
  return ready ||= (async () => {
    await Promise.all(['local', 'session'].map((area) => chrome.storage[area].setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })));
    const old = await chrome.storage.local.get(['apiKey', 'language', 'personalContext', 'settings', 'keys', 'localeRevision']);
    const migration = {};
    if (!old.settings) {
      const provider = old.apiKey?.startsWith('sk-ant-') ? 'claude' : 'openai';
      migration.settings = {
        provider, language: 'fr', personalContext: old.personalContext || '',
      };
      if (old.apiKey && !old.keys) migration.keys = { [provider]: old.apiKey };
    } else if (old.localeRevision !== 1) {
      // Apply the requested French default to existing installations, not just new ones.
      migration.settings = { ...old.settings, language: 'fr' };
    }
    if (old.localeRevision !== 1) migration.localeRevision = 1;
    if (Object.keys(migration).length) await chrome.storage.local.set(migration);
    await chrome.storage.local.remove(['apiKey', 'language', 'personalContext']);
  })();
}
export async function getSettings() {
  await initializeStorage();
  const [local, session] = await Promise.all([chrome.storage.local.get(['settings', 'keys']), chrome.storage.session.get('keys')]);
  const settings = { provider: 'openai', language: 'fr', personalContext: '', ...local.settings };
  // Reading depth belongs to the current discussion, not persisted preferences.
  delete settings.detail;
  const keys = { ...local.keys, ...session.keys };
  return { ...settings, keys, apiKey: keys[settings.provider] || '', rememberKey: Boolean(local.keys?.[settings.provider]), remembered: local.keys || {} };
}
export async function saveSettings(settings) {
  await initializeStorage();
  const { provider, language, personalContext, apiKey, rememberKey } = settings;
  const [local, session] = await Promise.all([chrome.storage.local.get('keys'), chrome.storage.session.get('keys')]);
  const persisted = { ...local.keys }, temporary = { ...session.keys };
  delete persisted[provider]; delete temporary[provider];
  if (apiKey) (rememberKey ? persisted : temporary)[provider] = apiKey;
  await chrome.storage.local.set({ settings: { provider, language, personalContext }, keys: persisted });
  await chrome.storage.session.set({ keys: temporary });
  return getSettings();
}
export async function cacheKey(thread, settings, mode) {
  // Votes fluctuate independently of the text and are not sent to the model.
  // Reopening an unchanged discussion must not incur another paid generation.
  const { score: ignoredPostScore, ...post } = thread;
  const source = { ...post, comments: thread.comments.map(({ score, ...comment }) => comment) };
  // Retry/action counts describe transport work, not the material analyzed.
  // They must not trigger another paid generation for identical coverage.
  if (thread.coverage) {
    const { complete, loaded, reported, reason, source: transport } = thread.coverage;
    source.coverage = { complete, loaded, reported, reason, source: transport };
  }
  const data = JSON.stringify({ thread: source, mode, model: MODELS[settings.provider], version: PROMPT_VERSION,
    language: settings.language, detail: settings.detail, personalContext: settings.personalContext });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return `analysis:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function readCache(key) { return (await chrome.storage.local.get(key))[key]?.result || null; }
export async function writeCache(key, result) {
  if (JSON.stringify(result).length * 2 > 3_000_000) return false;
  await chrome.storage.local.set({ [key]: { result, createdAt: Date.now() } });
  const all = await chrome.storage.local.get(null);
  let bytes = 0;
  const remove = Object.entries(all).filter(([k]) => k.startsWith('analysis:')).sort((a, b) => b[1].createdAt - a[1].createdAt)
    .filter((entry, i) => { bytes += JSON.stringify(entry).length * 2; return i >= 30 || bytes > 3_000_000; }).map(([k]) => k);
  if (remove.length) await chrome.storage.local.remove(remove);
  return true;
}
export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((key) => key.startsWith('analysis:')));
}
