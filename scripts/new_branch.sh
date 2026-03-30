#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <branch-name>"
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"
git checkout main
git pull --rebase
git checkout -b "$1"
echo "✔ Branch '$1' created from latest main"
