// Kept identical in the three extensions. No tokens pass through the host page.
const SETTINGS_KEY = 'githubArchive';
const TOKEN_KEY = 'githubArchiveToken';
export const DEPTHS = ['deep', 'detailed', 'short'];
export const DEPTH_LABELS = { deep: 'approfondi', detailed: 'détaillé', short: 'court' };

export function repositoryName(value) {
  const name = String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) || ['.', '..'].includes(name.split('/')[1]))
    throw new Error('Indique un dépôt sous la forme propriétaire/dépôt ou son URL GitHub.');
  return name;
}

async function protectStorage() {
  await Promise.all(['local', 'session'].map(area => chrome.storage[area].setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })));
}
export async function getArchiveSettings() {
  await protectStorage();
  const [local, session] = await Promise.all([
    chrome.storage.local.get([SETTINGS_KEY, TOKEN_KEY]), chrome.storage.session.get(TOKEN_KEY),
  ]);
  return { repository: 'sderosiaux/saved-youtube-hackernews-reddit-summaries', branch: '', ...local[SETTINGS_KEY],
    token: session[TOKEN_KEY] || local[TOKEN_KEY] || '', rememberToken: Boolean(local[TOKEN_KEY]) };
}
export async function saveArchiveSettings({ repository, branch, token, rememberToken }) {
  const settings = { repository: repositoryName(repository), branch: String(branch || '').trim() };
  if (!token?.trim() || /\s/.test(token.trim())) throw new Error('Ajoute un jeton GitHub valide, sans espaces.');
  await protectStorage();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const keep = rememberToken ? 'local' : 'session', clear = rememberToken ? 'session' : 'local';
  await chrome.storage[keep].set({ [TOKEN_KEY]: token.trim() });
  await chrome.storage[clear].remove(TOKEN_KEY);
}
export async function forgetArchiveToken() {
  await Promise.all(['local', 'session'].map(area => chrome.storage[area].remove(TOKEN_KEY)));
}

export function buildArchiveDocument({ medium, id, title, url, detail, language = 'fr', markdown }) {
  if (!['youtube', 'hackernews', 'reddit'].includes(medium) || !/^[\w-]{1,80}$/.test(String(id)) ||
      !DEPTHS.includes(detail) || !markdown?.trim()) throw new Error('Aucun résumé terminé à archiver.');
  const fields = { archive_format: 1, medium, source_id: String(id), title, source_url: url, detail, language };
  return { path: `${medium}/${id}.md`, detail, title,
    content: `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${markdown.trim()}\n` };
}

export async function selectCompletedSummary(load) {
  for (const detail of DEPTHS) {
    const result = await load(detail);
    if (result) return { detail, result };
  }
  throw new Error('Aucun résumé terminé disponible. Génère d’abord un résumé ; les Q/R et les textes interrompus ne sont pas archivés.');
}

const base64 = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const fromBase64 = text => new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(text.replace(/\s/g, '')), char => char.charCodeAt(0)));
function fieldsOf(text) {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  const fields = {};
  for (const line of header?.split('\n') || []) {
    const match = /^(archive_format|medium|source_id|detail): (.+)$/.exec(line);
    if (match) { try { fields[match[1]] = JSON.parse(match[2]); } catch { /* Not one of our files. */ } }
  }
  return fields;
}
function githubError(status) {
  const messages = {
    401: 'Le jeton GitHub est invalide ou a expiré. Mets-le à jour dans les paramètres des archives.',
    403: 'GitHub refuse l’accès. Vérifie les droits Contents en lecture/écriture sur ce dépôt et les limites de requêtes.',
    404: 'Dépôt ou branche GitHub introuvable, ou inaccessible avec ce jeton.',
    409: 'Le fichier a changé pendant l’enregistrement. Réessaie pour relire sa dernière version.',
    422: 'GitHub refuse ce commit. Vérifie la branche, ses règles de protection et les droits du jeton.',
  };
  return new Error(messages[status] || `GitHub n’a pas pu enregistrer ce résumé (HTTP ${status}). Réessaie.`);
}

export async function archiveToGitHub(document, settings, { fetchImpl = fetch } = {}) {
  const repository = repositoryName(settings.repository);
  if (!settings.token) throw new Error('Configure ton jeton GitHub pour archiver ce résumé.');
  const api = `https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
  async function request(url, options = {}) {
    try {
      return await fetchImpl(url, { ...options, credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(25_000), headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${settings.token}`,
          'X-GitHub-Api-Version': '2026-03-10', ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        } });
    } catch {
      throw new Error('Connexion à GitHub interrompue. Tu peux réessayer : un fichier déjà enregistré sera reconnu.');
    }
  }
  const repoResponse = await request(api);
  if (!repoResponse.ok) throw githubError(repoResponse.status);
  const repo = await repoResponse.json();
  const branch = settings.branch || repo.default_branch;
  if (!branch) throw new Error('GitHub n’a pas fourni de branche par défaut pour ce dépôt.');
  const endpoint = `${api}/contents/${document.path.split('/').map(encodeURIComponent).join('/')}`;
  const link = `https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${document.path}`;
  const desired = fieldsOf(document.content);
  // One optimistic retry handles a simultaneous commit from another extension/tab.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(`${endpoint}?ref=${encodeURIComponent(branch)}`);
    let sha;
    if (response.ok) {
      const file = await response.json();
      if (file.type !== 'file' || file.encoding !== 'base64' || !file.content || file.size > 1_000_000)
        throw new Error('Le chemin d’archive existe mais ne contient pas un résumé modifiable.');
      const previous = fromBase64(file.content), fields = fieldsOf(previous);
      if (fields.archive_format !== 1 || fields.medium !== desired.medium || fields.source_id !== desired.source_id || !DEPTHS.includes(fields.detail))
        throw new Error('Un fichier existe déjà à cet emplacement et n’a pas été créé par les extensions. Il a été conservé.');
      if (previous === document.content || DEPTHS.indexOf(fields.detail) < DEPTHS.indexOf(document.detail))
        return { url: link, unchanged: true, detail: fields.detail };
      sha = file.sha;
    } else if (response.status !== 404) throw githubError(response.status);
    const saved = await request(endpoint, { method: 'PUT', body: JSON.stringify({
      message: `${sha ? 'Actualise' : 'Archive'} ${desired.medium} : ${String(document.title).replace(/\s+/g, ' ').slice(0, 140)}`,
      content: base64(document.content), branch, ...(sha ? { sha } : {}),
    }) });
    if (saved.ok) return { url: link, unchanged: false, detail: document.detail };
    if (attempt === 0 && [409, 422].includes(saved.status)) continue;
    throw githubError(saved.status);
  }
}
