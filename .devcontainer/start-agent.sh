#!/usr/bin/env bash
# Launches the gateway agent in the background on every codespace start.
# postStartCommand blocks the codespace from reporting Available, so this
# script must return immediately.
set -euo pipefail

cd "$(dirname "$0")/.."
LOG=/tmp/mcp-agent.log

if [ -z "${MCP_GATEWAY_URL:-}" ] || [ -z "${MCP_AGENT_KEY:-}" ]; then
  echo "[start-agent] MCP_GATEWAY_URL / MCP_AGENT_KEY are not set."
  echo "[start-agent] Run scripts/provision-codespace-secrets.sh, then: gh codespace rebuild"
  exit 0
fi

# Never run two agents against the same queue.
pkill -f "agent/agent.mjs" >/dev/null 2>&1 || true

nohup node agent/agent.mjs >>"$LOG" 2>&1 &
disown || true

echo "[start-agent] agent started (pid $!). Tail it with: tail -f $LOG"
