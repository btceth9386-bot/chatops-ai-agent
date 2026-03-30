#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

NODE_PATTERN='node dist/src/index.js'
ACP_WRAPPER_PATTERN='kiro-cli acp'
ACP_CHILD_PATTERN='/Users/9icloud/.local/bin/kiro-cli-chat acp'

log() {
  printf '[restart-clean] %s\n' "$*"
}

list_matches() {
  local pattern="$1"
  ps -ef | grep "$pattern" | grep -v grep || true
}

kill_pattern() {
  local pattern="$1"
  pkill -f "$pattern" || true
}

force_kill_pattern() {
  local pattern="$1"
  pgrep -f "$pattern" >/dev/null 2>&1 || return 0
  pkill -9 -f "$pattern" || true
}

log 'stopping existing bot / ACP processes'
kill_pattern "$NODE_PATTERN"
kill_pattern "$ACP_WRAPPER_PATTERN"
kill_pattern "$ACP_CHILD_PATTERN"
sleep 2

log 'force-killing leftovers if needed'
force_kill_pattern "$NODE_PATTERN"
force_kill_pattern "$ACP_WRAPPER_PATTERN"
force_kill_pattern "$ACP_CHILD_PATTERN"
sleep 1

log 'verifying process table is clean'
NODE_LEFT="$(list_matches "$NODE_PATTERN")"
ACP_WRAPPER_LEFT="$(list_matches "$ACP_WRAPPER_PATTERN")"
ACP_CHILD_LEFT="$(list_matches "$ACP_CHILD_PATTERN")"

if [[ -n "$NODE_LEFT$ACP_WRAPPER_LEFT$ACP_CHILD_LEFT" ]]; then
  log 'cleanup failed; refusing to start a new instance'
  [[ -n "$NODE_LEFT" ]] && printf '%s\n' "$NODE_LEFT"
  [[ -n "$ACP_WRAPPER_LEFT" ]] && printf '%s\n' "$ACP_WRAPPER_LEFT"
  [[ -n "$ACP_CHILD_LEFT" ]] && printf '%s\n' "$ACP_CHILD_LEFT"
  exit 1
fi

log 'starting chatops-ai-agent'
exec npm start
