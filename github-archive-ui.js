import { getArchiveSettings, saveArchiveSettings, forgetArchiveToken, archiveToGitHub, DEPTH_LABELS } from './github-archive.js';

export async function openArchiveSettings() {
  if (document.getElementById('github-archive-dialog')) return false;
  const settings = await getArchiveSettings();
  if (document.getElementById('github-archive-dialog')) return false;
  const dialog = document.createElement('dialog');
  dialog.id = 'github-archive-dialog';
  dialog.className = 'github-archive-dialog';
  dialog.setAttribute('aria-labelledby', 'github-archive-title');
  // Static markup only. Repository names and tokens are assigned through .value.
  dialog.innerHTML = `
    <form>
      <div class="github-dialog-heading"><h2 id="github-archive-title">Archives GitHub</h2><button type="button" data-close aria-label="Fermer">×</button></div>
      <p>Un dépôt commun à tes résumés YouTube, Hacker News et Reddit. Seuls les résumés que tu choisis d’archiver y sont envoyés.</p>
      <label for="github-repository">Dépôt GitHub</label>
      <input id="github-repository" required placeholder="propriétaire/mes-lectures" autocomplete="off" spellcheck="false">
      <label for="github-branch">Branche <span>(facultatif)</span></label>
      <input id="github-branch" placeholder="Branche par défaut du dépôt" autocomplete="off" spellcheck="false">
      <label for="github-token">Jeton d’accès GitHub</label>
      <input id="github-token" type="password" autocomplete="off" spellcheck="false">
      <p class="github-hint">Crée un <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">jeton à accès limité</a> pour ce dépôt uniquement, avec « Contents: Read and write ».</p>
      <label class="github-checkbox"><input id="github-remember" type="checkbox"> Conserver le jeton sur cet appareil</label>
      <p class="github-hint">Sinon, il reste disponible jusqu’à la fermeture du navigateur. Aucun envoi vers Chrome Sync. Le stockage local n’est pas un coffre chiffré.</p>
      <p data-error role="alert" hidden></p>
      <div class="github-dialog-actions"><button type="button" data-forget>Effacer le jeton</button><button type="submit">Enregistrer</button></div>
    </form>`;
  const find = selector => dialog.querySelector(selector);
  find('#github-repository').value = settings.repository;
  find('#github-branch').value = settings.branch;
  find('#github-token').placeholder = settings.token ? 'Laisser vide pour conserver le jeton' : 'github_pat_…';
  find('#github-remember').checked = settings.rememberToken;
  let token = settings.token;
  const error = message => { find('[data-error]').textContent = message; find('[data-error]').hidden = false; };
  return new Promise(resolve => {
    dialog.addEventListener('close', () => { const saved = dialog.returnValue === 'saved'; dialog.remove(); resolve(saved); }, { once: true });
    find('[data-close]').addEventListener('click', () => dialog.close());
    find('[data-forget]').addEventListener('click', async () => {
      try { await forgetArchiveToken(); token = ''; find('#github-token').value = ''; find('#github-token').placeholder = 'github_pat_…'; error('Jeton effacé.'); }
      catch { error('Impossible d’effacer le jeton.'); }
    });
    find('form').addEventListener('submit', async event => {
      event.preventDefault();
      const submit = find('[type="submit"]'); submit.disabled = true;
      try {
        await saveArchiveSettings({ repository: find('#github-repository').value, branch: find('#github-branch').value,
          token: find('#github-token').value.trim() || token, rememberToken: find('#github-remember').checked });
        dialog.close('saved');
      } catch (err) { error(err.message); }
      finally { submit.disabled = false; }
    });
    document.body.append(dialog); dialog.showModal();
  });
}

export function createArchiveControl({ button, getDocument, isReady }) {
  let busy = false;
  const feedback = document.createElement('span');
  feedback.className = 'github-archive-feedback'; feedback.setAttribute('role', 'status'); feedback.hidden = true;
  (button.closest('.navigation, header') || button).after(feedback);
  function update() { button.disabled = busy || !isReady(); }
  button.title = 'Archiver le résumé terminé le plus complet, sans nouvelle génération';
  button.addEventListener('click', async () => {
    if (busy || !isReady()) return;
    busy = true; update(); feedback.hidden = true; feedback.replaceChildren(); button.textContent = 'Archivage…';
    try {
      // Capture exactly the completed summary selected by this click.
      const document = await getDocument();
      let settings = await getArchiveSettings();
      if (!settings.repository || !settings.token) {
        if (!await openArchiveSettings()) return;
        settings = await getArchiveSettings();
      }
      const result = await archiveToGitHub(document, settings);
      const link = window.document.createElement('a');
      link.href = result.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `Résumé ${DEPTH_LABELS[result.detail]} ${result.unchanged ? 'déjà archivé' : 'archivé'} ↗`;
      feedback.append(link); feedback.hidden = false;
    } catch (error) {
      feedback.textContent = error.message || 'Impossible d’archiver ce résumé.'; feedback.hidden = false;
    } finally { busy = false; button.textContent = 'Archiver sur GitHub'; update(); }
  });
  update();
  return { update };
}
