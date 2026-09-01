/*
 * codespace-mcp-gateway: Cloudflare Worker entrypoint.
 *
 * Routing:
 *   GET  /                 dark control dashboard (public page, no secrets)
 *   GET  /health           liveness + configuration check (public)
 *   POST /mcp              streamable-HTTP MCP endpoint (JSON-RPC 2.0)
 *   GET  /sse              legacy SSE MCP transport, POST /messages for replies
 *   GET  /api/state        dashboard state
 *   POST /api/run          queue a command from the dashboard
 *   GET  /api/command      fetch one command with full output
 *   POST /api/keepalive    extend the idle timer
 *   POST /api/teardown     delete or stop the codespace now
 *   POST /agent/poll       in-codespace agent long-polls for work
 *   POST /agent/result     in-codespace agent reports a finished command
 *   POST /agent/heartbeat  in-codespace agent keeps a running command alive
 *
 * Everything except / and /health requires the gateway key. Agent endpoints
 * accept AGENT_TOKEN when it is set, otherwise MCP_API_KEY.
 *
 * See util.js for the style note (no backticks, no backslash escapes).
 */

import {
  SERVER_NAME, SERVER_VERSION, corsHeaders, isAuthorized, jsonResponse,
  missingConfig, normalizePath, nowIso, unauthorized
} from "./util.js";
import { dashboardHtml } from "./dashboard.js";

export { CodespaceGateway } from "./gateway.js";

const MCP_PATHS = ["/mcp", "/sse", "/messages"];
const API_PATHS = ["/api/state", "/api/run", "/api/command", "/api/keepalive", "/api/teardown"];
const AGENT_PATHS = ["/agent/poll", "/agent/result", "/agent/heartbeat"];

function gatewayStub(env) {
  const id = env.GATEWAY.idFromName("global-codespace-gateway");
  return env.GATEWAY.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/health" || path === "/healthz") {
      const missing = missingConfig(env);
      return jsonResponse({
        ok: true,
        service: SERVER_NAME,
        version: SERVER_VERSION,
        time: nowIso(),
        configured: missing.length === 0,
        missingConfig: missing,
        repository: env.REPO_OWNER && env.REPO_NAME ? env.REPO_OWNER + "/" + env.REPO_NAME : null,
        endpoints: { mcp: "/mcp", sse: "/sse", dashboard: "/" }
      });
    }

    if (path === "/" || path === "/dashboard") {
      return new Response(dashboardHtml(env), {
        status: 200,
        headers: Object.assign(
          { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          corsHeaders()
        )
      });
    }

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const isAgent = AGENT_PATHS.indexOf(path) >= 0;
    const isMcp = MCP_PATHS.indexOf(path) >= 0;
    const isApi = API_PATHS.indexOf(path) >= 0;

    if (!isAgent && !isMcp && !isApi) {
      return jsonResponse({
        error: "not_found",
        path: path,
        endpoints: ["/", "/health"].concat(MCP_PATHS, API_PATHS, AGENT_PATHS)
      }, 404);
    }

    const missing = missingConfig(env);
    if (missing.length) {
      return jsonResponse({
        error: "configuration_error",
        message: "The gateway is missing required environment configuration. Set these as Worker secrets or vars.",
        missing: missing
      }, 500);
    }

    const expected = isAgent ? (env.AGENT_TOKEN || env.MCP_API_KEY) : env.MCP_API_KEY;
    if (!isAuthorized(request, url, expected)) return unauthorized();

    return gatewayStub(env).fetch(request);
  }
};
