#!/bin/bash
# Installation locale de jira-cli.
# - Installe les dépendances
# - Compile TypeScript
# - Rend le wrapper bash exécutable
# - Affiche la ligne PATH à ajouter au shell (non intrusif)

set -e

# Détection robuste du dossier du script (gère bash, sh, exécution via stdin, etc.).
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
if [ -z "$SCRIPT_SOURCE" ] || [ "$SCRIPT_SOURCE" = "bash" ] || [ "$SCRIPT_SOURCE" = "sh" ]; then
  # Script piped via stdin : on suppose qu'on est lancé depuis la racine du projet.
  ROOT_DIR="$(pwd)"
else
  ROOT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")/.." && pwd)"
fi
BIN_DIR="$ROOT_DIR/bin"

if [ ! -f "$ROOT_DIR/package.json" ]; then
  echo "Error: package.json introuvable dans $ROOT_DIR" >&2
  echo "Lance ce script depuis la racine du projet jira-cli : ./scripts/install.sh" >&2
  exit 1
fi

echo "→ Installing dependencies"
cd "$ROOT_DIR"
npm install

echo "→ Building TypeScript"
npm run build

echo "→ Making wrapper executable"
chmod +x "$BIN_DIR/jira.sh"

# Lien sans extension pour invoquer 'jira' au lieu de 'jira.sh'.
ln -sf "$BIN_DIR/jira.sh" "$BIN_DIR/jira"

cat <<EOF

✓ Installation complete.

Add the following line to your ~/.zshrc or ~/.bashrc to use 'jira' anywhere:

  export PATH="$BIN_DIR:\$PATH"

Then reload your shell (e.g. 'source ~/.zshrc') and configure your .env
(copy .env.example to .env and fill it in).

EOF
