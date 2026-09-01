#!/usr/bin/env bash
# Deploy the gateway Worker. Run scripts/set-secrets.sh first (or once, ever).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "node/npx is required: https://nodejs.org" >&2
  exit 1
fi

echo "==> installing wrangler"
npm install --silent

echo "==> deploying"
npx wrangler deploy

cat <<'EOF'

Done. Next:
  1. scripts/set-secrets.sh                 (GITHUB_TOKEN + MCP_API_KEY)
  2. scripts/provision-codespace-secrets.sh (so the codespace agent can dial home)
  3. curl -s https://codespace-mcp-gateway.<your-subdomain>.workers.dev/health
EOF
