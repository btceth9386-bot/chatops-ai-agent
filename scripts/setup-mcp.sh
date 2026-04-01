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

# Collect values into a temp file (avoids eval and associative arrays)
tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT

for var in $vars; do
  current="${!var:-}"
  if [[ -n "$current" ]]; then
    read -rp "$var [env: ${current:0:20}...]: " input
    printf '%s=%s\n' "$var" "${input:-$current}" >> "$tmpfile"
  else
    read -rp "$var: " input
    printf '%s=%s\n' "$var" "$input" >> "$tmpfile"
  fi
done

# Generate output by replacing placeholders
mkdir -p "$(dirname "$OUTPUT")"
content=$(<"$EXAMPLE")

while IFS='=' read -r var val; do
  [[ -z "$val" ]] && continue
  content="${content//\$\{$var\}/$val}"
done < "$tmpfile"

echo "$content" > "$OUTPUT"
echo ""
echo "✔ Written to $OUTPUT"
echo ""
echo "Variables filled:"
while IFS='=' read -r var val; do
  if [[ -n "$val" ]]; then
    echo "  ✅ $var"
  else
    echo "  ⏭️  $var (kept as placeholder)"
  fi
done < "$tmpfile"
