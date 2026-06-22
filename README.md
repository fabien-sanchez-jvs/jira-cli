# jira-cli

CLI pour **créer** et **modifier** des fiches Jira (Jira Cloud), en complément du
connecteur Atlassian de Claude qui est en lecture seule.

Opérations couvertes :

- **create** — créer une fiche (titre, description, assigné, sprint)
- **update** — modifier le titre et/ou la description
- **assign** — affecter / désaffecter un utilisateur
- **transition** — changer le statut (ou lister les transitions possibles)
- **sprint** — affecter une fiche à un sprint

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
# Créer une fiche
jira create -s "Bouton export grisé sur mobile" \
  -d "Sur l'écran Publications, le bouton Export reste grisé en < 768px." \
  -t Bug

# Description multi-lignes depuis un fichier (ou stdin avec '-')
jira create -s "Refonte du header" --description-file ./desc.md
cat desc.md | jira create -s "Refonte du header" --description-file -

# Créer + assigner + mettre dans un sprint (par nom, nécessite un board)
jira create -s "Titre" -a moi@jvs.fr --sprint "Sprint 42" --board 123
jira create -s "Titre" --sprint 456            # ou directement l'id du sprint

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
```

Ajoute `--json` à `create` pour une sortie machine (clé + URL), pratique pour
appeler l'outil depuis un script ou un workflow Claude.

Active les logs détaillés (URL des requêtes) avec `DEBUG=1`.

## Notes

- L'API Jira v3 attend le champ `description` au format **ADF** (Atlassian
  Document Format). La conversion depuis du texte brut est automatique
  (paragraphes séparés par une ligne vide). Le formatage riche n'est pas
  interprété.
- Les noms de **statut** (transition) et de **sprint** sont résolus de façon
  insensible à la casse et aux accents.
