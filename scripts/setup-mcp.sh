#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE="$REPO_ROOT/.kiro/settings/mcp.json.example"
OUTPUT="$HOME/.kiro/settings/mcp.json"

if [[ ! -f "$EXAMPLE" ]]; then
  echo "ERROR: Example file not found: $EXAMPLE" >&2
  exit 1
fi

if [[ -f "$OUTPUT" ]]; then
  echo "⚠️  $OUTPUT already exists."
  read -rp "Overwrite? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

# Extract all ${VAR_NAME} placeholders from the example
vars=$(grep -oE '\$\{[A-Z_]+\}' "$EXAMPLE" | sed 's/[${}]//g' | sort -u)

echo ""
echo "This script will generate $OUTPUT"
echo "Press Enter to keep a variable empty (will use the placeholder as-is)."
echo ""

declare -A values

for var in $vars; do
  # Check if already set in environment
  current="${!var:-}"
  if [[ -n "$current" ]]; then
    read -rp "$var [env: ${current:0:20}...]: " input
    values[$var]="${input:-$current}"
  else
    read -rp "$var: " input
    values[$var]="$input"
  fi
done

# Generate output by replacing placeholders
mkdir -p "$(dirname "$OUTPUT")"
content=$(<"$EXAMPLE")

for var in $vars; do
  val="${values[$var]}"
  if [[ -n "$val" ]]; then
    content="${content//\$\{$var\}/$val}"
  fi
done

echo "$content" > "$OUTPUT"
echo ""
echo "✔ Written to $OUTPUT"
echo ""
echo "Variables filled:"
for var in $vars; do
  if [[ -n "${values[$var]}" ]]; then
    echo "  ✅ $var"
  else
    echo "  ⏭️  $var (kept as placeholder)"
  fi
done
