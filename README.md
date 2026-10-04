# Reddit Distill

Une extension Chrome pour comprendre une discussion Reddit : les arguments, les objections, les expériences des participants et les questions ouvertes. Adaptée de [HN Distill](https://github.com/sderosiaux/chrome-ext-hn), avec le même lecteur en français.

## Installation

1. Cloner ce dépôt, ou télécharger et décompresser l’archive de l’extension.
2. Ouvrir `chrome://extensions` et activer le **Mode développeur**.
3. Cliquer sur **Charger l’extension non empaquetée** et sélectionner le dossier contenant `manifest.json`.
4. Ouvrir une discussion sur `www.reddit.com`, `old.reddit.com`, `new.reddit.com` ou `reddit.com`, puis cliquer sur **Distill** ou sur l’icône de l’extension.
5. Renseigner une clé OpenAI ou Anthropic. Les appels sont facturés par le fournisseur sur ce compte API. La lecture des commentaires dans **Discussion** fonctionne sans clé.

Aucune compilation, dépendance ou serveur n’est nécessaire pour utiliser l’extension. Après une mise à jour, recharger l’extension puis les onglets Reddit ouverts. Les clés de l’extension HN ne sont pas partagées automatiquement avec celle-ci.

[Exemple de discussion](https://www.reddit.com/r/ExperiencedDevs/comments/1wo8160/struggling_with_moral_implications_of_ai/).

## Archives GitHub

**Archiver sur GitHub** enregistre la synthèse approfondie si elle est déjà terminée, sinon la courte. Le bouton consulte les notes en mémoire et le cache correspondant à la discussion, aux sources et aux paramètres actuels, quel que soit l’onglet affiché. Il ne lance aucune génération et exclut les Q/R, brouillons et notes préparatoires.

Le dépôt proposé est `sderosiaux/saved-youtube-hackernews-reddit-summaries`, commun aux trois extensions. Le premier clic ouvre la configuration, également accessible dans **Paramètres → Archives GitHub**. Renseigner un [jeton GitHub à accès limité](https://github.com/settings/personal-access-tokens/new), autorisé sur ce dépôt avec **Contents: Read and write**. Le même jeton peut être saisi dans les trois extensions ; la connexion de la CLI `gh` n’est pas partagée avec Chrome. Le jeton reste en session, ou sur cet appareil si demandé, jamais dans Chrome Sync. Recharger l’extension pour activer la nouvelle autorisation `api.github.com`.

Chaque clic crée ou actualise `reddit/<id>.md` via l’API GitHub, sur la branche par défaut ou celle configurée. Le Markdown conserve titre, URL, niveau, langue, références, diagrammes Mermaid et indications de couverture partielle. Un contenu identique ne crée pas de commit ; une version courte ne remplace pas une archive approfondie. Un fichier non créé par les extensions n’est pas écrasé. Un lien vers le fichier apparaît après l’archivage.

## Lecture

- **Focus automatique sur Reddit** : à l’ouverture d’un thread, les barres du haut, de gauche et de droite, le champ de réponse et les actions (votes, Reply, Award, partage, menus) sont masqués. Le post et les commentaires sont recentrés, dans le thème Reddit actuel. Le tri, la recherche et les commandes pour déplier ou charger les réponses restent disponibles. La navigation habituelle revient en quittant le thread, y compris sans rechargement. Fonctionne sans clé API et sans ouvrir Distill.
- **Synthèse** : arguments, objections, témoignages et interprétations, organisés selon le contenu du fil.
- **Questions-réponses** : un parcours par sujet, avec les positions opposées dans leur contexte.
- **Discussion** : post et commentaires récupérés, avec les messages parents et les liens d’origine.
- **Courte / Approfondie** : aperçu concis par défaut ; explications plus développées sur demande.
- **Sources** : références contrôlées contre les identifiants réellement fournis au modèle, consultables dans le lecteur ou sur Reddit. Une référence valide ne prouve pas la véracité d’une affirmation.
- **Copier** : notes ou discussion en Markdown ou texte. Les exports signalent aussi les fils partiellement récupérés et les générations interrompues.
- **Actualiser** : relire le fil et les commentaires nouvellement chargés. Fermer puis rouvrir le lecteur relit également les données.

Les notes arrivent progressivement. Les longs fils sont répartis en lots avec leur contexte parental, puis réunis en une synthèse sourcée. Les notes de travail intermédiaires sont explicitement provisoires. La synthèse compresse le contenu : elle ne promet pas de restituer chaque détail.

Des schémas peuvent illustrer les relations utiles. L’extension construit elle-même les SVG à partir d’un graphe JSON validé ; elle n’exécute ni HTML ni code généré par le modèle. Les exports Markdown incluent ces schémas en Mermaid.

Le thème suit le système. Échap ferme les paramètres ou le lecteur, les flèches changent d’onglet. La langue des notes et le contexte personnel sont configurables ; le profil ajuste les explications sans écarter les avis contraires.

## Récupération des commentaires

L’extension récupère le JSON depuis l’onglet Reddit lui-même, avec sa session et son origine, puis charge les réponses supplémentaires et les branches différées. Cela évite les refus qui peuvent toucher une requête émise depuis l’iframe de l’extension. Le relais n’accepte que les opérations de lecture du fil ouvert ; aucune URL arbitraire ni clé API ne lui est transmise. Les appels `morechildren` sont séquentiels et contiennent au plus 100 identifiants, conformément à la [documentation Reddit](https://www.reddit.com/dev/api/#GET_api_morechildren). Elle conserve les relations parent/réponse, les commentaires courts et les repères de messages supprimés. Les scores ne sont pas considérés comme une preuve de vérité ou de consensus.

Si Reddit refuse le JSON ou laisse des réponses manquantes, l’extension explore automatiquement la page : boutons de réponses supplémentaires, commentaires repliés, chargement différé et liens vers les branches profondes. Les liens sont lus sans naviguer l’onglet. Les commentaires découverts sont accumulés même si Reddit retire ensuite des éléments du DOM. Seuls les contrôles de lecture du fil sont actionnés ; aucun vote, commentaire ou abonnement. L’avancement apparaît dans le lecteur, et **Arrêter** ou fermer Distill annule la collecte. Il n’est plus nécessaire de déplier les réponses manuellement.

Le nombre de commentaires lus et la couverture restent visibles au-dessus des notes. La collecte est considérée complète uniquement si les branches récupérées ne laissent aucun trou détecté et que le nombre annoncé est atteint. Le compteur Reddit peut inclure des commentaires modérés ou supprimés ; il ne garantit pas à lui seul l’exhaustivité. Les identifiants omis dans les réponses JSON sont retentés par lots plus petits, puis individuellement. Le parcours HTML suit aussi les curseurs de réponses imbriquées, même dans les branches chargées sans navigation. La collecte dispose de 30 secondes au total, dont au maximum 20 secondes pour le JSON ; le parcours HTML utilise le temps restant. Les fragments HTML différés dans des balises template sont aussi extraits. Trois branches HTML indépendantes peuvent être lues en parallèle. Seuls les nouveaux identifiants de commentaires comptent comme un progrès, en tenant compte des commentaires déjà obtenus par le JSON. Chaque parcours s’arrête aussi après 5 secondes sans nouveau commentaire ou 12 réponses consécutives sans apport. Les commentaires déjà récupérés sont conservés et l’analyse démarre même si le délai est atteint. La limite de sécurité reste de 15 000 commentaires ou branches ; un même chargement HTML en échec n’est tenté que deux fois. Si des commentaires restent manquants, le lecteur conserve la cause du blocage et le manque restant.

Les permaliens de commentaires ouvrent l’analyse du fil entier. Les changements de discussion sans rechargement de page annulent l’ancien lecteur. Les articles externes, images et vidéos ne sont pas téléchargés ni analysés : seules les données textuelles récupérées du post et des commentaires sont transmises au modèle.

## Confidentialité et stockage

- Les clés sont conservées dans `chrome.storage.session` par défaut, ou dans `chrome.storage.local` avec l’option **Conserver la clé sur cet appareil**. Aucun Chrome Sync.
- Le stockage des clés est réservé aux contextes de confiance de l’extension. L’ouverture du lecteur est liée au tab, à l’origine Reddit, à la discussion et à son iframe par un échange de vérification.
- Le texte récupéré et le contexte personnel sont envoyés uniquement au fournisseur choisi. Ne lancer une analyse que pour du contenu que l’on souhaite lui transmettre. Les données de session Reddit servent uniquement aux requêtes vers Reddit.
- OpenAI : modèle `gpt-6-luna`, Responses API, streaming, sortie JSON structurée, `store: false`. Anthropic : `claude-sonnet-4-5`, Messages API et sortie structurée. Les politiques de conservation des fournisseurs restent applicables.
- Seules les générations terminées et validées sont mises en cache localement, avec leur couverture. Le cache tient compte du contenu, du modèle, du prompt, du mode, de la profondeur, de la langue et du contexte. Limite : 30 résultats, environ 3 Mo.
- **Arrêter**, fermer le lecteur ou changer de lecture annule la requête locale. Cela ne garantit pas l’arrêt immédiat de la facturation du fournisseur. Les passages déjà reçus restent consultables comme notes incomplètes.
- Les paramètres permettent d’effacer les clés et les notes enregistrées. Aucun suivi, télémétrie ou backend propre à l’extension.

## Développement et vérification

Node.js 22 ou ultérieur pour les outils de développement uniquement :

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run package
```

L’archive produite dans `dist/` contient uniquement les fichiers nécessaires à l’extension et ce README. Le workflow GitHub Actions exécute les mêmes contrôles et publie cette archive comme artefact.

Les tests unitaires couvrent la collecte, la pagination, le relais depuis la page, le parcours automatique des réponses, les identifiants et sources, les exports, le découpage et le streaming. Les tests navigateur chargent réellement l’extension dans Chromium, avec des pages Reddit et réponses API contrôlées : paramètres, sources, Q/R, cache, transport depuis la page, expansion automatique après HTTP 403 même sous le dialogue, couverture, interruption, navigation SPA et refus d’un lecteur usurpé. Les appels IA y sont simulés ; ces tests ne mesurent pas la qualité d’un modèle réel et ne garantissent pas l’accès à Reddit depuis chaque réseau.

| Fichier | Rôle |
| --- | --- |
| `content.js`, `content.css`, `background.js` | Bouton, lecteur isolé, navigation Reddit et communication sécurisée |
| `data.js`, `reddit-dom.js`, `reddit-loader.js` | Collecte JSON, parcours automatique des réponses, lecture de la page, couverture et découpage |
| `prompts.js`, `analysis.js` | Instructions, schéma, validation des réponses et références |
| `api_client.js`, `generation.js` | Streaming et synthèse des longs fils |
| `panel.html`, `panel.js`, `panel.css`, `design-system.css` | Lecteur et paramètres |
| `render.js`, `markdown.js`, `diagrams.js`, `diagrams.css` | Sources, export et schémas |
| `storage.js` | Clés, préférences et cache |

Projet indépendant, non affilié à Reddit.
