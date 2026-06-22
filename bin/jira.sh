#!/bin/bash
# Wrapper qui lance le script compilé en préservant le cwd de l'appelant.
# Node hérite naturellement du cwd du shell — rien à faire de plus.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$SCRIPT_DIR/dist/index.js" "$@"
