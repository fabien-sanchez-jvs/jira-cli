# jira-cli

CLI pour **lire**, **créer** et **modifier** des fiches Jira (Jira Cloud), en
complément du connecteur Atlassian de Claude.

Opérations couvertes :

- **get** — lire le détail d'une fiche (titre, description, statut, priorité,
  assigné, reporter, parent, sprint, liens, sous-tâches, commentaires)
- **create** — créer une fiche (titre, description, assigné, sprint)
- **update** — modifier le titre et/ou la description
- **assign** — affecter / désaffecter un utilisateur
- **transition** — changer le statut (ou lister les transitions possibles)
- **sprint** — affecter une fiche à un sprint
- **epic** — rattacher (ou détacher) une fiche à une epic
- **block** — créer un lien de blocage entre deux fiches
- **comment** — ajouter un commentaire à une fiche
- **attach** — joindre un ou plusieurs fichiers à une fiche
- **attachments** — lister les pièces jointes d'une fiche
- **download** — télécharger une (ou toutes les) pièce(s) jointe(s)
- **skill** — générer un skill Claude Code clé en main (`SKILL.md`) décrivant
  l'outil (commandes, options, règles) pour un agent IA

## Installation

```bash
cd jira-cli
./scripts/install.sh
```

Le script installe les dépendances, compile le TypeScript (`dist/`), rend le
wrapper exécutable et affiche la ligne `PATH` à ajouter à ton shell :

```bash
export PATH="/chemin/vers/jira-cli/bin:$PATH"
```

Recharge ensuite ton shell (`source ~/.zshrc`).

## Configuration

Copie `.env.example` en `.env` et renseigne tes accès :

```bash
JIRA_URL=https://jvs-mairistem.atlassian.net
JIRA_EMAIL=toi@jvs.fr
JIRA_API_TOKEN=...        # https://id.atlassian.com/manage-profile/security/api-tokens

# Optionnel — évite de répéter les flags
JIRA_DEFAULT_PROJECT=COM
# JIRA_DEFAULT_TYPE=Story
# JIRA_DEFAULT_BOARD=123
```

Le `.env` est cherché d'abord dans le répertoire courant, puis à la racine de
l'outil installé : tu peux donc avoir une config globale, surchargée par projet.

L'authentification est en **Basic** (email + API token) et agit avec **tes
droits Jira**.

## Usage

```bash
# Lire le détail d'une fiche
jira get COM-1234
jira get COM-1234 --json   # sortie machine JSON

# Créer une fiche
jira create -s "Bouton export grisé sur mobile" \
  -d "Sur l'écran Publications, le bouton Export reste grisé en < 768px." \
  -t Bug

# Description depuis un fichier (ou stdin avec '-')
jira create -s "Refonte du header" --description-file ./desc.md
cat desc.md | jira create -s "Refonte du header" --description-file -

# Fichier .md : conversion Markdown→ADF + champs depuis le frontmatter YAML
# (title/project/type/assignee/epic/sprint/block — les flags CLI ont la priorité)
jira create --description-file ./fiche.md

# Par défaut, une fiche créée est rattachée au SPRINT ACTIF (déduit du projet)
jira create -s "Titre"                         # → sprint actif s'il existe
jira create -s "Titre" --no-sprint             # → créée hors sprint (backlog)

# Créer + assigner + cibler un sprint précis (par nom : board requis, voir plus bas)
jira create -s "Titre" -a moi@jvs.fr --sprint "Sprint 42" --board 123
jira create -s "Titre" --sprint 456            # ou directement l'id du sprint

# Rattacher directement à une epic à la création
jira create -s "Titre" --epic COM-100

# Créer une fiche bloquée par / bloquant une autre
jira create -s "Titre" --block "COM-200>"     # COM-200 bloque la fiche créée
jira create -s "Titre" --block ">COM-200"     # la fiche créée bloque COM-200

# Modifier
jira update COM-1234 -s "Nouveau titre"
jira update COM-1234 --description-file ./nouvelle-desc.md

# Affecter / désaffecter
jira assign COM-1234 collegue@jvs.fr
jira assign COM-1234 me
jira assign COM-1234 unassign

# Transitionner
jira transition COM-1234                # liste les transitions possibles
jira transition COM-1234 "En cours"

# Affecter à un sprint
jira sprint COM-1234 456
jira sprint COM-1234 "Sprint 42" --board 123

# Rattacher / détacher une epic
jira epic COM-1234 COM-100
jira epic COM-1234 none

# Lien de blocage (notation > relative à la fiche éditée)
jira block COM-1234 "COM-100>"    # COM-100 bloque COM-1234
jira block COM-1234 ">COM-200"    # COM-1234 bloque COM-200

# Commenter
jira comment COM-1234 "Reproduit en v2.3, priorité haute."
jira comment COM-1234 --file ./note.txt         # depuis un fichier
cat note.txt | jira comment COM-1234 --file -   # depuis stdin

# Pièces jointes
jira attach COM-1234 ./capture.png ./log.txt   # joindre des fichiers
jira attachments COM-1234                       # lister (nom, taille, id)
jira download COM-1234 capture.png              # télécharger par nom
jira download COM-1234 10042                    # ou par id d'attachement
jira download COM-1234 all --out ./dl           # tout, dans ./dl

# Générer le skill pour un agent IA
jira skill                       # écrit ./jira-cli/SKILL.md
jira skill -o ~/.claude/skills   # écrit ~/.claude/skills/jira-cli/SKILL.md
jira skill -o -                  # affiche le SKILL.md sur stdout
```

Ajoute `--json` à `create` pour une sortie machine
`{ "key", "url", "sprint", "epic", "block" }` (`sprint` = id du sprint affecté,
ou `null` ; `epic` = clé de l'epic de rattachement, ou `null` ; `block` = spec
de blocage appliquée, ou `null`), pratique pour appeler l'outil depuis un script
ou un workflow Claude.

Active les logs détaillés (URL des requêtes) avec `DEBUG=1`.

### `skill`

La commande `skill` génère, par introspection des commandes/options réellement
enregistrées, un **skill Claude Code clé en main** : un dossier contenant un
`SKILL.md` (frontmatter `name`/`description` de déclenchement + corps décrivant
objectif, invocation, règles d'usage et catalogue des commandes). C'est la
source de vérité « machine » : la regénérer après toute évolution de la CLI
garantit que l'agent dispose d'une description à jour. Le dossier généré porte
toujours le nom du skill (`jira-cli/`) ; le déposer dans `~/.claude/skills/`
(ou `.claude/skills/` d'un projet) suffit à l'activer.

- `-o, --output <DIR>` — dossier **parent** où créer le dossier `jira-cli/`
  contenant le `SKILL.md` (`-` pour afficher le `SKILL.md` sur stdout ; défaut :
  dossier courant). Le nom du dossier feuille n'est pas configurable : il doit
  correspondre au nom du skill pour que celui-ci soit reconnu.

## Notes

- L'API Jira v3 attend le champ `description` au format **ADF** (Atlassian
  Document Format). La conversion est automatique :
  - fichier **`.md`** → conversion Markdown complète (titres, gras, italique,
    code inline, blocs de code, listes, blockquotes, liens) ;
  - texte brut / `--description` → paragraphes séparés par une ligne vide.
- **Frontmatter YAML** dans un `.md` : le bloc `---` en tête de fichier est
  stripé du corps et ses champs alimentent les options de la commande —
  `title` → `--summary`, `project`, `type`, `assignee`, `epic`, `sprint`,
  `block`. Les flags CLI ont toujours la priorité. Exemple :
  ```yaml
  ---
  title: Bug — export grisé sur mobile
  type: Bug
  assignee: me
  epic: COM-100
  ---
  ```
  Puis : `jira create --description-file ./fiche.md`
- Les noms de **statut** (transition) et de **sprint** sont résolus de façon
  insensible à la casse et aux accents.
- Cibler un **sprint par nom** nécessite un board. Ordre de résolution :
  `--board <id>`, sinon `JIRA_DEFAULT_BOARD`, sinon **déduction** depuis les
  boards scrum du projet (le projet vient de `--project` pour `create`, ou de la
  clé de la fiche pour `sprint`, ex. `COM-1234` → `COM`). Comme le nom du sprint
  est connu, on le cherche sur chaque board scrum :
  - présent sur **un seul** board → ce board est choisi ;
  - présent sur **plusieurs** → on retient celui où le sprint est **actif** ;
  - sinon (0 board scrum, sprint introuvable, ou ambiguïté persistante) → erreur
    explicite invitant à préciser `--board`.

  Un id numérique de sprint fonctionne toujours sans board.
- À la **création**, sans `--sprint`, la fiche est rattachée au **sprint actif**
  déduit du board/projet (même résolution de board que ci-dessus). S'il n'existe
  pas de sprint actif unique (aucun, ou plusieurs), la fiche est créée **hors
  sprint** sans erreur. Utilise `--no-sprint` pour forcer la création hors sprint.
- Le **rattachement à une epic** passe par le champ `parent` de l'API v3 (sur
  Jira Cloud moderne, l'epic est le **parent** de la fiche). À la création,
  `--epic <KEY>` ; sur une fiche existante, `jira epic <key> <epicKey>` (et
  `jira epic <key> none` pour détacher).
- Le **lien de blocage** utilise le type Jira « Blocks ». La direction se note
  avec la flèche `>`, relative à la fiche éditée (celle passée en argument, ou
  la fiche créée pour `--block`) : `AUTRE>` = *AUTRE bloque la fiche* ; `>AUTRE`
  = *la fiche bloque AUTRE*. Disponible sur une fiche existante
  (`jira block <key> <spec>`) et à la création (`--block <spec>`).
- **Pièces jointes** : `attach` envoie les fichiers en `multipart/form-data` ;
  `download` sélectionne par **nom de fichier** (insensible à la casse/accents),
  par **id** d'attachement, ou `all` pour tout, et écrit dans `--out` (défaut :
  dossier courant). Si deux pièces jointes portent le même nom, les suivantes
  sont préfixées par leur id pour éviter d'écraser.
- **Pièces jointes vidéo** : quand les fichiers téléchargés sont des **vidéos**,
  [**ffmpeg**](https://ffmpeg.org/) est l'outil recommandé pour les inspecter et
  les traiter en local — par ex. lire les métadonnées
  (`ffprobe capture.mp4`), extraire une image (`ffmpeg -i capture.mp4 -ss 5 -vframes 1 frame.png`),
  recompresser, découper ou convertir le format. S'il n'est pas installé :
  - **macOS** : `brew install ffmpeg`
  - **Debian/Ubuntu** : `sudo apt install ffmpeg`
  - **Fedora** : `sudo dnf install ffmpeg`
  - **Windows** : `winget install Gyan.FFmpeg` ou `choco install ffmpeg`
  - sinon, binaires statiques sur <https://ffmpeg.org/download.html>.
