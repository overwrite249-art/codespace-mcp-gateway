#!/usr/bin/env bash
# Push the two required secrets into Cloudflare. Values are read from stdin so
# they never land in your shell history, in this repo, or in wrangler.toml.
set -euo pipefail
cd "$(dirname "$0")/.."

put() {
  local name="$1" prompt="$2" value
  read -rsp "$prompt: " value
  echo
  if [ -z "$value" ]; then
    echo "skipped $name (empty)"
    return
  fi
  printf '%s' "$value" | npx wrangler secret put "$name"
}

echo "GITHUB_TOKEN needs the 'codespace' scope only."
echo "Create one at https://github.com/settings/tokens"
echo

put GITHUB_TOKEN "GitHub PAT (codespace scope)"
put MCP_API_KEY  "Gateway API key (clients send it as x-api-key)"

echo
read -rp "Set a separate AGENT_TOKEN for the in-codespace agent? [y/N] " answer
if [[ "${answer:-N}" =~ ^[Yy]$ ]]; then
  put AGENT_TOKEN "Agent token"
fi

echo "done. run: npx wrangler deploy"
