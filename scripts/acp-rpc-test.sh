#!/usr/bin/env bash
set -euo pipefail

COMMAND="${ACP_COMMAND:-kiro-cli acp}"
TIMEOUT_SECONDS="45"
CWD_OVERRIDE="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_NAME="senior-agent"
MODE="interactive"
LOAD_SESSION_ID=""
PROMPT_TEXT=""

usage() {
  cat <<'EOF'
Usage:
  scripts/acp-rpc-test.sh interactive [--cwd /path] [--timeout 45] [--agent senior-agent]
  scripts/acp-rpc-test.sh new [--cwd /path] [--timeout 45] [--agent senior-agent] [--prompt "hello"]
  scripts/acp-rpc-test.sh load --session-id <id> [--cwd /path] [--timeout 45] [--prompt "hello"]

Modes:
  interactive   Start one ACP process and keep it open for manual JSON-RPC testing.
  new           One-shot: initialize + session/new (+ optional prompt).
  load          One-shot: initialize + session/load (+ optional prompt).

Examples:
  ./scripts/acp-rpc-test.sh interactive
  ./scripts/acp-rpc-test.sh new --prompt "Say hi"
  ./scripts/acp-rpc-test.sh load --session-id <id> --timeout 45

Interactive commands:
  help
  initialize
  new
  load <sessionId>
  prompt <sessionId> <text>
  raw <full-json-rpc-payload>
  vars
  quit

Placeholders inside interactive mode:
  {{cwd}}         -> current cwd override
  {{agent}}       -> current agent name
  {{session_id}}  -> last session id returned by new/load

Standard RPC examples:
  initialize
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true},"clientInfo":{"name":"acp-rpc-test","version":"0.1.0"}}}

  session/new
  {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"{{cwd}}","agentName":"{{agent}}","mcpServers":[]}}

  session/load
  {"jsonrpc":"2.0","id":3,"method":"session/load","params":{"sessionId":"{{session_id}}","cwd":"{{cwd}}","mcpServers":[]}}

  session/prompt
  {"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"{{session_id}}","prompt":[{"type":"text","text":"What do you remember?"}]}}
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

MODE="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      LOAD_SESSION_ID="$2"
      shift 2
      ;;
    --prompt)
      PROMPT_TEXT="$2"
      shift 2
      ;;
    --agent)
      AGENT_NAME="$2"
      shift 2
      ;;
    --cwd)
      CWD_OVERRIDE="$2"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "interactive" && "$MODE" != "new" && "$MODE" != "load" ]]; then
  echo "Mode must be interactive, new, or load" >&2
  exit 1
fi

if [[ "$MODE" == "load" && -z "$LOAD_SESSION_ID" ]]; then
  echo "--session-id is required for load mode" >&2
  exit 1
fi

python3 - "$COMMAND" "$MODE" "$LOAD_SESSION_ID" "$PROMPT_TEXT" "$AGENT_NAME" "$CWD_OVERRIDE" "$TIMEOUT_SECONDS" <<'PY'
import json
import subprocess
import sys
import time
import threading
import queue

try:
    tty_in = open('/dev/tty', 'r', encoding='utf-8', errors='replace')
except OSError:
    tty_in = sys.stdin

command, mode, load_session_id, prompt_text, agent_name, cwd_override, timeout_seconds = sys.argv[1:8]
timeout_seconds = float(timeout_seconds)

proc = subprocess.Popen(
    ["sh", "-lc", command],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

q = queue.Queue()
next_id = 1
last_session_id = load_session_id or ""

print(f"[info] command={command}")
print(f"[info] pid={proc.pid}")
print(f"[info] cwd={cwd_override}")
print(f"[info] mode={mode}")
print(f"[info] timeout_seconds={timeout_seconds}")


def pump_stdout():
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        print(f"[acp stdout] {line}")
        try:
            q.put(json.loads(line))
        except Exception as exc:
            q.put({"_parse_error": str(exc), "raw": line})


def pump_stderr():
    for line in proc.stderr:
        line = line.rstrip("\n")
        if line:
            print(f"[acp stderr] {line}", file=sys.stderr)

threading.Thread(target=pump_stdout, daemon=True).start()
threading.Thread(target=pump_stderr, daemon=True).start()


def send_payload(payload, timeout=timeout_seconds, label=None):
    raw = json.dumps(payload, ensure_ascii=False)
    print(f"[rpc send] {raw}")
    proc.stdin.write(raw + "\n")
    proc.stdin.flush()

    request_id = payload.get("id")
    started = time.monotonic()
    while True:
        remaining = timeout - (time.monotonic() - started)
        if remaining <= 0:
            raise TimeoutError(f"Timeout waiting for response to {label or payload.get('method', 'request')} after {timeout:.1f}s")
        try:
            message = q.get(timeout=remaining)
        except queue.Empty:
            raise TimeoutError(f"Timeout waiting for response to {label or payload.get('method', 'request')} after {timeout:.1f}s")

        if request_id is not None and message.get("id") == request_id:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            print(f"[timing] {label or payload.get('method', 'request')}_ms={elapsed_ms}")
            print(f"[result] {label or payload.get('method', 'request')}={json.dumps(message, ensure_ascii=False)}")
            return message
        else:
            print(f"[rpc notice] {json.dumps(message, ensure_ascii=False)}")


def send_request(method, params, timeout=timeout_seconds, label=None):
    global next_id
    request_id = next_id
    next_id += 1
    return send_payload({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }, timeout=timeout, label=label or method)


def result_session_id(message, fallback=""):
    result = message.get("result") or {}
    if isinstance(result, dict):
        return result.get("sessionId", fallback)
    return fallback


def initialize():
    return send_request("initialize", {
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": {"readTextFile": True, "writeTextFile": True},
            "terminal": True,
        },
        "clientInfo": {
            "name": "acp-rpc-test",
            "version": "0.1.0",
        },
    })


def session_new():
    global last_session_id
    msg = send_request("session/new", {
        "cwd": cwd_override,
        "agentName": agent_name,
        "mcpServers": [],
    })
    last_session_id = result_session_id(msg, fallback=last_session_id)
    print(f"[state] last_session_id={last_session_id}")
    return msg


def session_load(session_id):
    global last_session_id
    msg = send_request("session/load", {
        "sessionId": session_id,
        "cwd": cwd_override,
        "mcpServers": [],
    })
    last_session_id = result_session_id(msg, fallback=session_id)
    print(f"[state] last_session_id={last_session_id}")
    return msg


def session_prompt(session_id, text):
    return send_request("session/prompt", {
        "sessionId": session_id,
        "prompt": [{"type": "text", "text": text}],
    }, timeout=max(timeout_seconds, 90.0))


def expand_placeholders(text):
    return (text
        .replace("{{cwd}}", cwd_override)
        .replace("{{agent}}", agent_name)
        .replace("{{session_id}}", last_session_id)
    )


def print_help():
    print("""
Commands:
  help
  initialize
  new
  load <sessionId>
  prompt <sessionId> <text>
  raw <json>
  vars
  quit

Examples:
  initialize
  new
  load {{session_id}}
  prompt {{session_id}} What do you remember?
  raw {"jsonrpc":"2.0","id":9,"method":"session/load","params":{"sessionId":"{{session_id}}","cwd":"{{cwd}}","mcpServers":[]}}
""".strip())

try:
    if mode == "interactive":
        print_help()
        print(f"[hint] process pid={proc.pid}")
        print(f"[hint] start with: initialize")
        while True:
            try:
                sys.stdout.write("acp> ")
                sys.stdout.flush()
                line = tty_in.readline()
                if line == '':
                    break
                line = line.strip()
            except EOFError:
                break
            if not line:
                continue

            expanded = expand_placeholders(line)
            parts = expanded.split(maxsplit=2)
            cmd = parts[0]

            try:
                if cmd in {"quit", "exit"}:
                    break
                elif cmd == "help":
                    print_help()
                elif cmd == "vars":
                    print(f"[vars] pid={proc.pid}")
                    print(f"[vars] cwd={cwd_override}")
                    print(f"[vars] agent={agent_name}")
                    print(f"[vars] session_id={last_session_id}")
                elif cmd == "initialize":
                    initialize()
                elif cmd == "new":
                    session_new()
                elif cmd == "load":
                    if len(parts) < 2:
                        print("usage: load <sessionId>")
                        continue
                    session_load(parts[1])
                elif cmd == "prompt":
                    if len(parts) < 3:
                        print("usage: prompt <sessionId> <text>")
                        continue
                    session_prompt(parts[1], parts[2])
                elif cmd == "raw":
                    if len(expanded.split(maxsplit=1)) < 2:
                        print("usage: raw <json>")
                        continue
                    raw_json = expanded.split(maxsplit=1)[1]
                    payload = json.loads(raw_json)
                    send_payload(payload, timeout=max(timeout_seconds, 90.0), label="raw")
                else:
                    print(f"unknown command: {cmd}")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
    else:
        initialize()
        if mode == "new":
            session_new()
        else:
            session_load(load_session_id)

        if prompt_text:
            target_session = last_session_id or load_session_id
            session_prompt(target_session, prompt_text)

except Exception as exc:
    print(f"[error] {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(1)
finally:
    try:
        if proc.poll() is None:
            print(f"[info] terminating acp pid={proc.pid}")
            proc.terminate()
    except Exception:
        pass
    try:
        proc.wait(timeout=3)
        print(f"[info] acp exited rc={proc.returncode}")
    except Exception:
        try:
            if proc.poll() is None:
                print(f"[warn] acp pid={proc.pid} did not exit after SIGTERM; killing")
                proc.kill()
                proc.wait(timeout=3)
                print(f"[info] acp killed rc={proc.returncode}")
        except Exception:
            pass
PY
