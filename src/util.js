/*
 * Shared helpers for the codespace MCP gateway Worker.
 *
 * STYLE NOTE: every file under src/ deliberately avoids backticks, template
 * literals and backslash escapes so the modules can be uploaded verbatim by
 * the Cloudflare API without any bundling step. NL is the newline constant and
 * HTML attributes use single quotes.
 */

export const SERVER_NAME = "codespace-mcp-gateway";
export const SERVER_VERSION = "1.0.0";
export const GITHUB_API = "https://api.github.com";
export const DEFAULT_PROTOCOL = "2025-06-18";
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const NL = String.fromCharCode(10);

export const DEFAULT_MACHINE = "basicLinux32gb";
export const DEFAULT_IDLE_TIMEOUT_MS = 300000;
export const ALARM_INTERVAL_MS = 30000;
export const AGENT_HOLD_MS = 25000;
export const AGENT_OFFLINE_MS = 120000;
export const RUNNING_STALE_MS = 900000;
export const DEFAULT_WAIT_MS = 60000;
export const MAX_WAIT_MS = 90000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 600000;
export const MAX_COMMAND_TIMEOUT_MS = 3600000;
export const MAX_OUTPUT_CHARS = 30000;
export const MAX_HISTORY = 100;
export const MAX_EVENTS = 40;

const READY_STATES = ["Available"];
const PENDING_STATES = ["Created", "Queued", "Provisioning", "Awaiting", "Starting", "Updating", "Rebuilding", "Exporting", "Moved", "Unknown"];
const STOPPED_STATES = ["Shutdown", "ShuttingDown", "Shutting Down"];
const DEAD_STATES = ["Deleted", "Failed", "Unavailable", "Archived"];

export function normalizePath(value) {
  let out = String(value === undefined || value === null ? "/" : value);
  while (out.length > 1 && out.charAt(out.length - 1) === "/") out = out.slice(0, -1);
  return out.length ? out : "/";
}

export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-api-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400"
  };
}

export function jsonResponse(body, status, extra) {
  const headers = Object.assign(
    { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    corsHeaders(),
    extra || {}
  );
  return new Response(JSON.stringify(body, null, 2), { status: status || 200, headers: headers });
}

export function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

export function nowIso() { return new Date().toISOString(); }

export function intOr(value, fallback) {
  const raw = value === undefined || value === null ? "" : String(value);
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

export function clampInt(value, min, max, fallback) {
  const parsed = intOr(value, fallback);
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function truncateText(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  if (text.length <= max) return { text: text, truncated: false };
  return {
    text: text.slice(0, max) + NL + "[... truncated " + (text.length - max) + " characters ...]",
    truncated: true
  };
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function presentedKeys(request, url) {
  const keys = [];
  const direct = request.headers.get("x-api-key");
  if (direct) keys.push(direct.trim());
  const auth = request.headers.get("authorization");
  if (auth) {
    const trimmed = auth.trim();
    const lower = trimmed.toLowerCase();
    const prefixes = ["bearer ", "token ", "apikey "];
    let stripped = trimmed;
    for (let i = 0; i < prefixes.length; i++) {
      if (lower.indexOf(prefixes[i]) === 0) {
        stripped = trimmed.slice(prefixes[i].length).trim();
        break;
      }
    }
    keys.push(stripped);
    keys.push(trimmed);
  }
  const query = url.searchParams.get("api_key") || url.searchParams.get("key");
  if (query) keys.push(query.trim());
  return keys;
}

export function isAuthorized(request, url, expected) {
  if (!expected) return false;
  const keys = presentedKeys(request, url);
  for (let i = 0; i < keys.length; i++) {
    if (timingSafeEqual(keys[i], String(expected))) return true;
  }
  return false;
}

export function unauthorized() {
  return jsonResponse(
    {
      error: "unauthorized",
      message: "Missing or invalid gateway key. Send it as x-api-key, as Authorization: Bearer <key>, or as ?api_key=<key> when opening /sse."
    },
    401,
    { "www-authenticate": 'Bearer realm="codespace-mcp-gateway"' }
  );
}

export function missingConfig(env) {
  const missing = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.MCP_API_KEY) missing.push("MCP_API_KEY");
  if (!env.REPO_OWNER) missing.push("REPO_OWNER");
  if (!env.REPO_NAME) missing.push("REPO_NAME");
  return missing;
}

export function classifyState(state) {
  const value = String(state === undefined || state === null ? "Unknown" : state);
  if (READY_STATES.indexOf(value) >= 0) return "ready";
  if (STOPPED_STATES.indexOf(value) >= 0) return "stopped";
  if (DEAD_STATES.indexOf(value) >= 0) return "dead";
  return "pending";
}

export function isTerminalStatus(status) {
  return status === "done" || status === "error" || status === "canceled";
}

export function randomId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result: result };
}

export function rpcError(id, code, message, data) {
  const error = { code: code, message: message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: error };
}

export function toolText(text, structured, isError) {
  const payload = { content: [{ type: "text", text: text }] };
  if (structured !== undefined && structured !== null) payload.structuredContent = structured;
  if (isError) payload.isError = true;
  return payload;
}

export function summarizeCommand(cmd, previewChars) {
  const preview = previewChars || 400;
  return {
    id: cmd.id,
    command: cmd.command,
    cwd: cmd.cwd,
    status: cmd.status,
    exitCode: cmd.exitCode === undefined ? null : cmd.exitCode,
    createdAt: cmd.createdAt,
    startedAt: cmd.startedAt,
    finishedAt: cmd.finishedAt,
    durationMs: cmd.finishedAt && cmd.startedAt ? cmd.finishedAt - cmd.startedAt : null,
    error: cmd.error || null,
    source: cmd.source || "mcp",
    truncated: !!cmd.truncated,
    stdoutPreview: truncateText(cmd.stdout, preview).text,
    stderrPreview: truncateText(cmd.stderr, preview).text
  };
}

export function formatCommand(cmd) {
  const lines = [];
  lines.push("command: " + cmd.command);
  lines.push("id: " + cmd.id);
  lines.push("status: " + cmd.status + (cmd.exitCode === null || cmd.exitCode === undefined ? "" : " (exit code " + cmd.exitCode + ")"));
  if (cmd.cwd) lines.push("cwd: " + cmd.cwd);
  if (cmd.startedAt) lines.push("started: " + new Date(cmd.startedAt).toISOString());
  if (cmd.finishedAt) {
    const base = cmd.startedAt || cmd.createdAt;
    lines.push("finished: " + new Date(cmd.finishedAt).toISOString() + " (" + ((cmd.finishedAt - base) / 1000).toFixed(1) + " s)");
  }
  if (cmd.error) lines.push("error: " + cmd.error);
  lines.push("");
  lines.push("--- stdout ---");
  lines.push(cmd.stdout && cmd.stdout.length ? cmd.stdout : "(empty)");
  lines.push("--- stderr ---");
  lines.push(cmd.stderr && cmd.stderr.length ? cmd.stderr : "(empty)");
  if (!isTerminalStatus(cmd.status)) {
    lines.push("");
    lines.push("Command is still " + cmd.status + ". Call get_command with command_id " + cmd.id + " to collect the final result.");
  }
  return lines.join(NL);
}
