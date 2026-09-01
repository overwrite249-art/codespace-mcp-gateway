#!/usr/bin/env bash
# Give the codespace the two values its agent needs to call the gateway back.
# Requires the GitHub CLI: https://cli.github.com  (gh auth login)
set -euo pipefail

REPO="${REPO:-overwrite249-art/codespace-mcp-gateway}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required: https://cli.github.com" >&2
  exit 1
fi

read -rp  "Gateway URL (https://codespace-mcp-gateway.<subdomain>.workers.dev): " GATEWAY_URL
read -rsp "Agent key (AGENT_TOKEN, or MCP_API_KEY if you did not set one): " AGENT_KEY
echo

GATEWAY_URL="${GATEWAY_URL%/}"

# Repository-level Codespaces secrets: available to every codespace made from
# this repo. Swap --repo for '--user --repos "$REPO"' if you prefer user scope.
gh secret set MCP_GATEWAY_URL --app codespaces --repo "$REPO" --body "$GATEWAY_URL"
gh secret set MCP_AGENT_KEY   --app codespaces --repo "$REPO" --body "$AGENT_KEY"
gh secret set MCP_AGENT_CONCURRENCY --app codespaces --repo "$REPO" --body "2"

cat <<EOF

Set on $REPO (codespaces scope):
  MCP_GATEWAY_URL      = $GATEWAY_URL
  MCP_AGENT_KEY        = (hidden)
  MCP_AGENT_CONCURRENCY= 2

Existing codespaces need a rebuild to pick these up:
  gh codespace rebuild
EOF
