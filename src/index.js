/*
 * codespace-mcp-gateway
 *
 * A Model Context Protocol (MCP) gateway that runs on Cloudflare Workers and
 * manages exactly ONE shared GitHub Codespace on demand.
 *
 *   1. Single active instance
 *      Every command first checks GET /user/codespaces for an existing
 *      codespace on REPO_OWNER/REPO_NAME. If one is alive it is reused. If one
 *      is stopped it is restarted with POST /user/codespaces/{name}/start. Only
 *      when nothing exists is a new 2-core box created with
 *      POST /repos/{owner}/{repo}/codespaces and machine basicLinux32gb.
 *      Creation is single-flighted inside one Durable Object, so parallel
 *      commands can never race into two codespaces.
 *
 *   2. Command queue and auto teardown
 *      Commands are tracked in Durable Object storage (queued / running /
 *      done / error / canceled). A Durable Object alarm ticks every 30s. The
 *      codespace is deleted with DELETE /user/codespaces/{name} only when
 *      nothing is running, nothing is queued, and no command has been received
 *      or finished for IDLE_TIMEOUT_MS (default 5 minutes).
 *
 *   3. Secrets
 *      GITHUB_TOKEN, MCP_API_KEY (and optional AGENT_TOKEN) are read only from
 *      the runtime environment. REPO_OWNER and REPO_NAME are plain vars.
 *      /sse, /mcp, /messages and /api/* require x-api-key or
 *      Authorization: Bearer against MCP_API_KEY, otherwise 401.
 *
 * Commands actually execute through a tiny Node agent (agent/agent.mjs) that
 * runs inside the codespace and long-polls this Worker for work. GitHub has no
 * REST endpoint for running a command inside a codespace, and an outbound
 * poller needs no public ports, no SSH keys and no port-visibility juggling.
 *
 * STYLE NOTE: this file deliberately contains no backticks, no template
 * literals and no backslash escapes, so it can be embedded verbatim in
 * deployment tooling. NL is the newline constant; HTML attributes use single
 * quotes.
 */

const SERVER_NAME = "codespace-mcp-gateway";
const SERVER_VERSION = "1.0.0";
const GITHUB_API = "https://api.github.com";
const DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const NL = String.fromCharCode(10);

const DEFAULT_MACHINE = "basicLinux32gb";
const DEFAULT_IDLE_TIMEOUT_MS = 300000;
const ALARM_INTERVAL_MS = 30000;
const AGENT_HOLD_MS = 25000;
const AGENT_OFFLINE_MS = 120000;
const RUNNING_STALE_MS = 900000;
const DEFAULT_WAIT_MS = 60000;
const MAX_WAIT_MS = 90000;
const DEFAULT_COMMAND_TIMEOUT_MS = 600000;
const MAX_COMMAND_TIMEOUT_MS = 3600000;
const MAX_OUTPUT_CHARS = 30000;
const MAX_HISTORY = 100;
const MAX_EVENTS = 40;

const READY_STATES = ["Available"];
const PENDING_STATES = ["Created", "Queued", "Provisioning", "Awaiting", "Starting", "Updating", "Rebuilding", "Exporting", "Moved", "Unknown"];
const STOPPED_STATES = ["Shutdown", "ShuttingDown", "Shutting Down"];
const DEAD_STATES = ["Deleted", "Failed", "Unavailable", "Archived"];

/* ------------------------------------------------------------------ utils */

function normalizePath(value) {
  let out = String(value === undefined || value === null ? "/" : value);
  while (out.length > 1 && out.charAt(out.length - 1) === "/") out = out.slice(0, -1);
  return out.length ? out : "/";
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-api-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400"
  };
}

function jsonResponse(body, status, extra) {
  const headers = Object.assign(
    { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    corsHeaders(),
    extra || {}
  );
  return new Response(JSON.stringify(body, null, 2), { status: status || 200, headers: headers });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function nowIso() { return new Date().toISOString(); }

function intOr(value, fallback) {
  const raw = value === undefined || value === null ? "" : String(value);
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = intOr(value, fallback);
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function truncateText(value, max) {
  const text = value === undefined || value === null ? "" : String(value);
  if (text.length <= max) return { text: text, truncated: false };
  const cut = text.slice(0, max);
  return { text: cut + NL + "[... truncated " + (text.length - max) + " characters ...]", truncated: true };
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedKeys(request, url) {
  const keys = [];
  const direct = request.headers.get("x-api-key");
  if (direct) keys.push(direct.trim());
  const auth = request.headers.get("authorization");
  if (auth) {
    const trimmed = auth.trim();
    const lower = trimmed.toLowerCase();
    const prefixes = ["bearer ", "token ", "apikey ", "basic "];
    let stripped = trimmed;
    for (let i = 0; i < prefixes.length; i++) {
      if (lower.indexOf(prefixes[i]) === 0) { stripped = trimmed.slice(prefixes[i].length).trim(); break; }
    }
    keys.push(stripped);
    keys.push(trimmed);
  }
  const query = url.searchParams.get("api_key") || url.searchParams.get("key");
  if (query) keys.push(query.trim());
  return keys;
}

function isAuthorized(request, url, expected) {
  if (!expected) return false;
  const keys = presentedKeys(request, url);
  for (let i = 0; i < keys.length; i++) {
    if (timingSafeEqual(keys[i], String(expected))) return true;
  }
  return false;
}

function unauthorized() {
  return jsonResponse(
    {
      error: "unauthorized",
      message: "Missing or invalid gateway key. Send it as the x-api-key header, as Authorization: Bearer <key>, or as ?api_key=<key> on /sse."
    },
    401,
    { "www-authenticate": 'Bearer realm="codespace-mcp-gateway"' }
  );
}

function missingConfig(env) {
  const missing = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.MCP_API_KEY) missing.push("MCP_API_KEY");
  if (!env.REPO_OWNER) missing.push("REPO_OWNER");
  if (!env.REPO_NAME) missing.push("REPO_NAME");
  return missing;
}

function classifyState(state) {
  const value = String(state === undefined || state === null ? "Unknown" : state);
  if (READY_STATES.indexOf(value) >= 0) return "ready";
  if (STOPPED_STATES.indexOf(value) >= 0) return "stopped";
  if (DEAD_STATES.indexOf(value) >= 0) return "dead";
  if (PENDING_STATES.indexOf(value) >= 0) return "pending";
  return "pending";
}

function isTerminalStatus(status) {
  return status === "done" || status === "error" || status === "canceled";
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result: result };
}

function rpcError(id, code, message, data) {
  const error = { code: code, message: message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: error };
}

function toolText(text, structured, isError) {
  const payload = { content: [{ type: "text", text: text }] };
  if (structured !== undefined && structured !== null) payload.structuredContent = structured;
  if (isError) payload.isError = true;
  return payload;
}

function randomId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return prefix + "_" + Date.now().toString(36) + rand;
}

function summarizeCommand(cmd, previewChars) {
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

function formatCommand(cmd) {
  const lines = [];
  lines.push("command: " + cmd.command);
  lines.push("id: " + cmd.id);
  lines.push("status: " + cmd.status + (cmd.exitCode === null || cmd.exitCode === undefined ? "" : " (exit code " + cmd.exitCode + ")"));
  if (cmd.cwd) lines.push("cwd: " + cmd.cwd);
  if (cmd.startedAt) lines.push("started: " + new Date(cmd.startedAt).toISOString());
  if (cmd.finishedAt) {
    const base = cmd.startedAt || cmd.createdAt;
    lines.push("finished: " + new Date(cmd.finishedAt).toISOString() + " (" + ((cmd.finishedAt - base) / 1000).toFixed(1) + "s)");
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

/* ------------------------------------------------------------- tool schema */

const TOOLS = [
  {
    name: "run_command",
    title: "Run a shell command in the shared codespace",
    description: "Queue a shell command for the single shared GitHub Codespace and wait for its output. Creates or restarts the codespace if needed, otherwise reuses the running one. Long commands keep running after the wait window expires; poll get_command with the returned id.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command, executed with bash -lc inside the codespace workspace." },
        cwd: { type: "string", description: "Optional working directory. Defaults to the repository checkout in /workspaces." },
        timeout_ms: { type: "integer", description: "Hard kill timeout for the process inside the codespace. Default 600000, max 3600000." },
        wait: { type: "boolean", description: "Wait for the result instead of returning immediately. Default true." },
        wait_ms: { type: "integer", description: "How long to wait for the result in this call. Default 60000, max 90000." }
      },
      required: ["command"],
      additionalProperties: false
    },
    annotations: { title: "Run command in codespace", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "get_command",
    title: "Get a queued or finished command",
    description: "Fetch the current state and full output of a previously queued command, optionally waiting for it to finish.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", description: "Identifier returned by run_command." },
        wait_ms: { type: "integer", description: "Optionally block up to this long for the command to finish. Default 0, max 90000." }
      },
      required: ["command_id"],
      additionalProperties: false
    },
    annotations: { title: "Get command result", readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "list_commands",
    title: "List recent commands",
    description: "List recent commands with their status, exit code and output previews. Useful to see what is queued or still running on the shared codespace.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many commands to return, newest first. Default 20, max 100." },
        status: { type: "string", enum: ["queued", "running", "done", "error", "canceled", "active", "all"], description: "Filter by status. active means queued or running. Default all." }
      },
      additionalProperties: false
    },
    annotations: { title: "List commands", readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "cancel_command",
    title: "Cancel a command",
    description: "Cancel a queued command, or ask the in-codespace agent to kill a running one.",
    inputSchema: {
      type: "object",
      properties: { command_id: { type: "string", description: "Identifier returned by run_command." } },
      required: ["command_id"],
      additionalProperties: false
    },
    annotations: { title: "Cancel command", readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  {
    name: "codespace_status",
    title: "Codespace and queue status",
    description: "Report the shared codespace (name, state, machine), the command queue, whether the in-codespace agent is online, and how long until idle auto-teardown.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Codespace status", readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "start_codespace",
    title: "Start or reuse the shared codespace",
    description: "Ensure the shared codespace exists and is running without queueing a command. Reuses an active codespace, restarts a stopped one, or creates a new 2-core basicLinux32gb codespace.",
    inputSchema: {
      type: "object",
      properties: {
        wait_for_ready: { type: "boolean", description: "Poll until the codespace reports Available. Default false." },
        wait_ms: { type: "integer", description: "How long to poll for readiness. Default 60000, max 90000." }
      },
      additionalProperties: false
    },
    annotations: { title: "Start codespace", readOnlyHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "stop_codespace",
    title: "Stop or delete the shared codespace now",
    description: "Tear the shared codespace down immediately instead of waiting for the idle timer. mode delete removes it (DELETE /user/codespaces/{name}), mode stop only shuts it down so it can be restarted later.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["delete", "stop"], description: "Default delete." },
        force: { type: "boolean", description: "Tear down even while commands are queued or running. Default false." }
      },
      additionalProperties: false
    },
    annotations: { title: "Stop codespace", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "keep_alive",
    title: "Extend the idle timer",
    description: "Push back the idle auto-teardown deadline, for example while a human is working in the codespace.",
    inputSchema: {
      type: "object",
      properties: { minutes: { type: "integer", description: "Minutes to keep the codespace alive from now. Default 15, max 240." } },
      additionalProperties: false
    },
    annotations: { title: "Keep alive", readOnlyHint: false, idempotentHint: false }
  }
];

/* ------------------------------------------------------------------ worker */

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
      return jsonResponse({
        ok: true,
        service: SERVER_NAME,
        version: SERVER_VERSION,
        time: nowIso(),
        configured: missingConfig(env).length === 0
      });
    }

    if (path === "/" || path === "/dashboard") {
      return new Response(dashboardHtml(env), {
        status: 200,
        headers: Object.assign({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, corsHeaders())
      });
    }

    if (path === "/favicon.ico") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const missing = missingConfig(env);
    if (missing.length) {
      return jsonResponse({
        error: "configuration_error",
        message: "The gateway is missing required environment configuration. Set these as Worker secrets or vars.",
        missing: missing
      }, 500);
    }

    const isAgentPath = path === "/agent/poll" || path === "/agent/result" || path === "/agent/heartbeat";
    const isMcpPath = path === "/mcp" || path === "/sse" || path === "/messages";
    const isApiPath = path === "/api/state" || path === "/api/run" || path === "/api/command" || path === "/api/keepalive" || path === "/api/teardown";

    if (!isAgentPath && !isMcpPath && !isApiPath) {
      return jsonResponse({ error: "not_found", path: path }, 404);
    }

    const expected = isAgentPath ? (env.AGENT_TOKEN || env.MCP_API_KEY) : env.MCP_API_KEY;
    if (!isAuthorized(request, url, expected)) return unauthorized();

    return gatewayStub(env).fetch(request);
  }
};

/* ---------------------------------------------------------- durable object */

export class CodespaceGateway {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.meta = null;
    this.commands = new Map();
    this.order = [];
    this.commandWaiters = new Map();
    this.agentWaiters = [];
    this.sseSessions = new Map();
    this.mcpSessions = new Set();
    this.ensurePromise = null;

    const self = this;
    ctx.blockConcurrencyWhile(async function () { await self.load(); });
  }

  /* ------------------------------------------------------------- storage */

  async load() {
    const stored = await this.storage.get("meta");
    this.meta = Object.assign({
      codespace: null,
      lastCommandAt: 0,
      lastFinishAt: 0,
      keepAliveUntil: 0,
      agentSeenAt: 0,
      agentId: null,
      seq: 0,
      lastTeardown: null,
      events: []
    }, stored || {});
    this.order = (await this.storage.get("order")) || [];
    if (this.order.length) {
      const keys = this.order.map(function (id) { return "cmd:" + id; });
      const loaded = await this.storage.get(keys);
      const self = this;
      loaded.forEach(function (value, key) { self.commands.set(key.slice(4), value); });
    }
  }

  async saveMeta() { await this.storage.put("meta", this.meta); }

  async saveCommand(cmd) { await this.storage.put("cmd:" + cmd.id, cmd); }

  async saveOrder() { await this.storage.put("order", this.order); }

  async trimHistory() {
    let changed = false;
    while (this.order.length > MAX_HISTORY) {
      const id = this.order[0];
      const cmd = this.commands.get(id);
      if (cmd && !isTerminalStatus(cmd.status)) break;
      this.order.shift();
      this.commands.delete(id);
      await this.storage.delete("cmd:" + id);
      changed = true;
    }
    if (changed) await this.saveOrder();
  }

  log(type, detail) {
    if (!this.meta.events) this.meta.events = [];
    this.meta.events.push({ at: Date.now(), type: type, detail: detail || null });
    while (this.meta.events.length > MAX_EVENTS) this.meta.events.shift();
  }

  /* -------------------------------------------------------------- config */

  machine() { return this.env.CODESPACE_MACHINE || DEFAULT_MACHINE; }

  idleTimeoutMs() {
    return clampInt(this.env.IDLE_TIMEOUT_MS, 60000, 86400000, DEFAULT_IDLE_TIMEOUT_MS);
  }

  repoFullName() { return String(this.env.REPO_OWNER) + "/" + String(this.env.REPO_NAME); }

  /* ---------------------------------------------------------- github api */

  async gh(method, path, body, attempt) {
    const tries = attempt || 0;
    const init = {
      method: method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: "Bearer " + this.env.GITHUB_TOKEN,
        "x-github-api-version": "2022-11-28",
        "user-agent": SERVER_NAME + "/" + SERVER_VERSION
      }
    };
    if (body !== undefined && body !== null) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(GITHUB_API + path, init);
    const text = await response.text();
    let data = null;
    if (text && text.length) {
      try { data = JSON.parse(text); } catch (parseError) { data = { message: truncateText(text, 400).text }; }
    }

    const retryable = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
    if (retryable && tries < 2) {
      await sleep(600 * (tries + 1));
      return this.gh(method, path, body, tries + 1);
    }

    if (!response.ok) {
      const detail = data && data.message ? data.message : "HTTP " + response.status;
      const error = new Error("GitHub " + method + " " + path + " -> " + response.status + ": " + detail);
      error.status = response.status;
      error.githubMessage = detail;
      throw error;
    }
    return data;
  }

  setCodespace(raw, createdByGateway) {
    const previous = this.meta.codespace;
    const same = previous && previous.name === raw.name;
    const readyNow = classifyState(raw.state) === "ready";
    this.meta.codespace = {
      name: raw.name,
      state: raw.state,
      stateClass: classifyState(raw.state),
      displayName: raw.display_name || null,
      machine: raw.machine && raw.machine.name ? raw.machine.name : null,
      cores: raw.machine && raw.machine.cpus ? raw.machine.cpus : null,
      memoryMb: raw.machine && raw.machine.memory_in_bytes ? Math.round(raw.machine.memory_in_bytes / 1048576) : null,
      repository: raw.repository && raw.repository.full_name ? raw.repository.full_name : this.repoFullName(),
      webUrl: raw.web_url || null,
      gitStatus: raw.git_status ? { ref: raw.git_status.ref || null, ahead: raw.git_status.ahead, uncommitted: raw.git_status.has_uncommitted_changes } : null,
      createdAt: same && previous.createdAt ? previous.createdAt : Date.now(),
      readyAt: readyNow ? (same && previous.readyAt ? previous.readyAt : Date.now()) : null,
      lastCheckedAt: Date.now(),
      createdByGateway: createdByGateway ? true : (same ? !!previous.createdByGateway : false)
    };
    return this.meta.codespace;
  }

  async listRepoCodespaces() {
    const listed = await this.gh("GET", "/user/codespaces?per_page=100");
    const all = listed && listed.codespaces ? listed.codespaces : [];
    const wanted = this.repoFullName().toLowerCase();
    return all.filter(function (item) {
      const full = item && item.repository && item.repository.full_name ? String(item.repository.full_name).toLowerCase() : "";
      return full === wanted;
    });
  }

  ensureCodespace() {
    if (!this.ensurePromise) {
      const self = this;
      this.ensurePromise = this.ensureCodespaceInner().then(
        function (value) { self.ensurePromise = null; return value; },
        function (error) { self.ensurePromise = null; throw error; }
      );
    }
    return this.ensurePromise;
  }

  async ensureCodespaceInner() {
    const existing = await this.listRepoCodespaces();
    let chosen = null;
    const ranks = ["ready", "pending", "stopped"];
    for (let r = 0; r < ranks.length && !chosen; r++) {
      for (let i = 0; i < existing.length; i++) {
        if (classifyState(existing[i].state) === ranks[r]) { chosen = existing[i]; break; }
      }
    }

    let action = "reused";
    if (!chosen) {
      const body = { machine: this.machine() };
      if (this.env.REPO_REF) body.ref = this.env.REPO_REF;
      if (this.env.DEVCONTAINER_PATH) body.devcontainer_path = this.env.DEVCONTAINER_PATH;
      body.idle_timeout_minutes = clampInt(this.env.CODESPACE_IDLE_MINUTES, 5, 240, 30);
      body.retention_period_minutes = clampInt(this.env.CODESPACE_RETENTION_MINUTES, 0, 43200, 120);
      const created = await this.gh("POST", "/repos/" + this.env.REPO_OWNER + "/" + this.env.REPO_NAME + "/codespaces", body);
      chosen = created;
      action = "created";
      this.setCodespace(chosen, true);
      this.log("codespace_created", { name: chosen.name, machine: this.machine(), state: chosen.state });
    } else if (classifyState(chosen.state) === "stopped") {
      const started = await this.gh("POST", "/user/codespaces/" + chosen.name + "/start");
      chosen = started;
      action = "started";
      this.setCodespace(chosen, false);
      this.log("codespace_started", { name: chosen.name, state: chosen.state });
    } else {
      const previous = this.meta.codespace;
      this.setCodespace(chosen, false);
      if (!previous || previous.name !== chosen.name) {
        this.log("codespace_adopted", { name: chosen.name, state: chosen.state });
      }
    }

    await this.saveMeta();
    await this.scheduleAlarm();
    return { action: action, codespace: this.meta.codespace, siblings: existing.length };
  }

  async refreshCodespace() {
    const current = this.meta.codespace;
    if (!current) return null;
    try {
      const raw = await this.gh("GET", "/user/codespaces/" + current.name);
      const previousState = current.state;
      this.setCodespace(raw, false);
      if (classifyState(raw.state) === "dead") {
        this.log("codespace_lost", { name: current.name, state: raw.state });
        this.meta.codespace = null;
      } else if (previousState !== raw.state) {
        this.log("codespace_state", { name: current.name, from: previousState, to: raw.state });
      }
      await this.saveMeta();
      return this.meta.codespace;
    } catch (error) {
      if (error && error.status === 404) {
        this.log("codespace_gone", { name: current.name });
        this.meta.codespace = null;
        await this.saveMeta();
        return null;
      }
      this.log("github_error", { where: "refresh", message: String(error && error.message ? error.message : error) });
      await this.saveMeta();
      return current;
    }
  }

  async waitForReady(waitMs) {
    const deadline = Date.now() + clampInt(waitMs, 1000, MAX_WAIT_MS, DEFAULT_WAIT_MS);
    while (Date.now() < deadline) {
      const current = this.meta.codespace;
      if (current && classifyState(current.state) === "ready") return current;
      await sleep(3000);
      await this.refreshCodespace();
      if (!this.meta.codespace) {
        try { await this.ensureCodespace(); } catch (error) { break; }
      }
    }
    return this.meta.codespace;
  }

  /* --------------------------------------------------------- queue state */

  counts() {
    let queued = 0;
    let running = 0;
    for (let i = 0; i < this.order.length; i++) {
      const cmd = this.commands.get(this.order[i]);
      if (!cmd) continue;
      if (cmd.status === "queued") queued++;
      else if (cmd.status === "running" || cmd.status === "canceling") running++;
    }
    return { queued: queued, running: running, total: this.order.length };
  }

  idleBaseline() {
    const codespace = this.meta.codespace;
    return Math.max(
      this.meta.lastCommandAt || 0,
      this.meta.lastFinishAt || 0,
      codespace && codespace.createdAt ? codespace.createdAt : 0
    );
  }

  teardownAt() {
    if (!this.meta.codespace) return null;
    const active = this.counts();
    if (active.queued > 0 || active.running > 0) return null;
    const idleDeadline = this.idleBaseline() + this.idleTimeoutMs();
    return Math.max(idleDeadline, this.meta.keepAliveUntil || 0);
  }

  agentOnline() {
    return !!this.meta.agentSeenAt && Date.now() - this.meta.agentSeenAt < AGENT_OFFLINE_MS;
  }

  recentCommands(limit, statusFilter) {
    const max = clampInt(limit, 1, 100, 20);
    const out = [];
    for (let i = this.order.length - 1; i >= 0 && out.length < max; i--) {
      const cmd = this.commands.get(this.order[i]);
      if (!cmd) continue;
      if (statusFilter && statusFilter !== "all") {
        if (statusFilter === "active") {
          if (cmd.status !== "queued" && cmd.status !== "running" && cmd.status !== "canceling") continue;
        } else if (cmd.status !== statusFilter) continue;
      }
      out.push(summarizeCommand(cmd));
    }
    return out;
  }

  publicState() {
    const active = this.counts();
    const teardown = this.teardownAt();
    return {
      service: SERVER_NAME,
      version: SERVER_VERSION,
      now: Date.now(),
      repository: this.repoFullName(),
      machine: this.machine(),
      idleTimeoutMs: this.idleTimeoutMs(),
      codespace: this.meta.codespace,
      counts: active,
      agent: { online: this.agentOnline(), lastSeenAt: this.meta.agentSeenAt || null, id: this.meta.agentId || null },
      teardownAt: teardown,
      teardownInMs: teardown === null ? null : Math.max(0, teardown - Date.now()),
      keepAliveUntil: this.meta.keepAliveUntil || null,
      lastTeardown: this.meta.lastTeardown || null,
      commands: this.recentCommands(20, "all"),
      events: (this.meta.events || []).slice().reverse()
    };
  }

  /* -------------------------------------------------------- command flow */

  async enqueue(input) {
    const command = String(input.command === undefined || input.command === null ? "" : input.command).trim();
    if (!command.length) {
      const error = new Error("command must be a non-empty string");
      error.invalidParams = true;
      throw error;
    }
    const now = Date.now();
    this.meta.seq = (this.meta.seq || 0) + 1;
    const cmd = {
      id: "cmd_" + now.toString(36) + "_" + this.meta.seq,
      command: command,
      cwd: input.cwd ? String(input.cwd) : null,
      timeoutMs: clampInt(input.timeoutMs, 1000, MAX_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS),
      status: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: null,
      truncated: false,
      source: input.source || "mcp",
      agentId: null,
      agentSeenAt: null,
      cancelRequested: false
    };
    this.commands.set(cmd.id, cmd);
    this.order.push(cmd.id);
    this.meta.lastCommandAt = now;
    this.log("command_queued", { id: cmd.id, command: truncateText(command, 120).text });
    await this.saveCommand(cmd);
    await this.saveOrder();
    await this.trimHistory();
    await this.saveMeta();
    await this.scheduleAlarm();
    this.wakeAgents();
    return cmd;
  }

  wakeAgents() {
    const waiters = this.agentWaiters;
    this.agentWaiters = [];
    for (let i = 0; i < waiters.length; i++) {
      try { waiters[i](); } catch (error) { /* ignore */ }
    }
  }

  resolveCommandWaiters(cmd) {
    const waiters = this.commandWaiters.get(cmd.id);
    if (!waiters) return;
    this.commandWaiters.delete(cmd.id);
    for (let i = 0; i < waiters.length; i++) {
      try { waiters[i](cmd); } catch (error) { /* ignore */ }
    }
  }

  waitForCommand(id, waitMs) {
    const existing = this.commands.get(id);
    if (!existing) return Promise.resolve(null);
    if (isTerminalStatus(existing.status)) return Promise.resolve(existing);
    const budget = clampInt(waitMs, 0, MAX_WAIT_MS, 0);
    if (budget <= 0) return Promise.resolve(existing);
    const self = this;
    return new Promise(function (resolve) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        const list = self.commandWaiters.get(id) || [];
        const index = list.indexOf(waiter);
        if (index >= 0) list.splice(index, 1);
        resolve(self.commands.get(id) || null);
      }, budget);
      function waiter(cmd) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(cmd);
      }
      const list = self.commandWaiters.get(id) || [];
      list.push(waiter);
      self.commandWaiters.set(id, list);
    });
  }

  async claimNextCommand(agentId) {
    for (let i = 0; i < this.order.length; i++) {
      const cmd = this.commands.get(this.order[i]);
      if (!cmd || cmd.status !== "queued") continue;
      cmd.status = "running";
      cmd.startedAt = Date.now();
      cmd.agentId = agentId || null;
      cmd.agentSeenAt = Date.now();
      await this.saveCommand(cmd);
      this.log("command_started", { id: cmd.id });
      await this.saveMeta();
      return cmd;
    }
    return null;
  }

  async completeCommand(id, payload) {
    const cmd = this.commands.get(id);
    if (!cmd) return null;
    if (isTerminalStatus(cmd.status)) return cmd;
    const stdout = truncateText(payload.stdout, MAX_OUTPUT_CHARS);
    const stderr = truncateText(payload.stderr, MAX_OUTPUT_CHARS);
    cmd.stdout = stdout.text;
    cmd.stderr = stderr.text;
    cmd.truncated = stdout.truncated || stderr.truncated || !!payload.truncated;
    cmd.exitCode = payload.exitCode === undefined || payload.exitCode === null ? null : intOr(payload.exitCode, null);
    cmd.error = payload.error ? String(payload.error) : null;
    cmd.finishedAt = Date.now();
    cmd.status = payload.error ? "error" : "done";
    if (payload.canceled) { cmd.status = "canceled"; cmd.error = cmd.error || "canceled"; }
    this.meta.lastFinishAt = cmd.finishedAt;
    this.log("command_finished", { id: cmd.id, status: cmd.status, exitCode: cmd.exitCode });
    await this.saveCommand(cmd);
    await this.saveMeta();
    await this.scheduleAlarm();
    this.resolveCommandWaiters(cmd);
    return cmd;
  }

  pendingCancels() {
    const ids = [];
    for (let i = 0; i < this.order.length; i++) {
      const cmd = this.commands.get(this.order[i]);
      if (cmd && cmd.cancelRequested && (cmd.status === "running" || cmd.status === "canceling")) ids.push(cmd.id);
    }
    return ids;
  }

  /* ---------------------------------------------------------- teardown */

  async teardown(reason, mode) {
    const codespace = this.meta.codespace;
    if (!codespace) return { ok: false, message: "No codespace is currently tracked." };
    const name = codespace.name;
    const useStop = mode === "stop";
    try {
      if (useStop) await this.gh("POST", "/user/codespaces/" + name + "/stop");
      else await this.gh("DELETE", "/user/codespaces/" + name);
    } catch (error) {
      if (!(error && error.status === 404)) {
        this.log("teardown_failed", { name: name, reason: reason, message: String(error && error.message ? error.message : error) });
        await this.saveMeta();
        throw error;
      }
    }
    this.log(useStop ? "codespace_stopped" : "codespace_deleted", { name: name, reason: reason });
    this.meta.lastTeardown = { name: name, reason: reason, mode: useStop ? "stop" : "delete", at: Date.now() };
    this.meta.codespace = null;
    this.meta.keepAliveUntil = 0;
    this.meta.agentSeenAt = 0;
    await this.saveMeta();
    await this.scheduleAlarm();
    return { ok: true, name: name, mode: useStop ? "stop" : "delete", reason: reason };
  }

  async maybeTeardown() {
    const at = this.teardownAt();
    if (at === null) return null;
    if (Date.now() < at) return null;
    try {
      return await this.teardown("idle for " + Math.round(this.idleTimeoutMs() / 60000) + " minutes", "delete");
    } catch (error) {
      return null;
    }
  }

  async requeueStaleCommands() {
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < this.order.length; i++) {
      const cmd = this.commands.get(this.order[i]);
      if (!cmd || (cmd.status !== "running" && cmd.status !== "canceling")) continue;
      const seen = cmd.agentSeenAt || cmd.startedAt || cmd.createdAt;
      const limit = Math.max(RUNNING_STALE_MS, cmd.timeoutMs + 120000);
      if (now - seen > limit) {
        cmd.status = "error";
        cmd.error = "the in-codespace agent stopped reporting for this command";
        cmd.finishedAt = now;
        this.meta.lastFinishAt = now;
        await this.saveCommand(cmd);
        this.log("command_orphaned", { id: cmd.id });
        this.resolveCommandWaiters(cmd);
        changed = true;
      }
    }
    if (changed) await this.saveMeta();
  }

  async scheduleAlarm() {
    const active = this.counts();
    const needed = !!this.meta.codespace || active.queued > 0 || active.running > 0;
    const current = await this.storage.getAlarm();
    if (!needed) {
      if (current !== null) await this.storage.deleteAlarm();
      return;
    }
    const target = Date.now() + ALARM_INTERVAL_MS;
    if (current === null || current > target) await this.storage.setAlarm(target);
  }

  async alarm() {
    try {
      if (this.meta.codespace) await this.refreshCodespace();
      await this.requeueStaleCommands();
      const active = this.counts();
      if (active.queued > 0 && !this.meta.codespace) {
        try { await this.ensureCodespace(); } catch (error) {
          this.log("ensure_failed", { message: String(error && error.message ? error.message : error) });
          await this.saveMeta();
        }
      }
      await this.maybeTeardown();
    } catch (error) {
      this.log("alarm_error", { message: String(error && error.message ? error.message : error) });
      try { await this.saveMeta(); } catch (ignored) { /* ignore */ }
    }
    await this.scheduleAlarm();
  }

  /* ------------------------------------------------------------- routing */

  async fetch(request) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    try {
      if (path === "/mcp") return await this.handleMcp(request, url);
      if (path === "/sse") return await this.handleSseOpen(request, url);
      if (path === "/messages") return await this.handleSseMessage(request, url);
      if (path === "/api/state") return jsonResponse(this.publicState());
      if (path === "/api/run") return await this.handleApiRun(request);
      if (path === "/api/command") return await this.handleApiCommand(request, url);
      if (path === "/api/keepalive") return await this.handleApiKeepAlive(request);
      if (path === "/api/teardown") return await this.handleApiTeardown(request, url);
      if (path === "/agent/poll") return await this.handleAgentPoll(request);
      if (path === "/agent/result") return await this.handleAgentResult(request);
      if (path === "/agent/heartbeat") return await this.handleAgentHeartbeat(request);
      return jsonResponse({ error: "not_found", path: path }, 404);
    } catch (error) {
      return jsonResponse({
        error: "internal_error",
        message: String(error && error.message ? error.message : error)
      }, error && error.status === 401 ? 502 : 500);
    }
  }

  /* --------------------------------------------------------- mcp: /mcp */

  async handleMcp(request, url) {
    if (request.method === "GET") {
      return jsonResponse({
        error: "method_not_allowed",
        message: "This server does not open server-initiated streams on GET /mcp. POST JSON-RPC to /mcp, or use the legacy /sse transport."
      }, 405, { allow: "POST, DELETE, OPTIONS" });
    }
    if (request.method === "DELETE") {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) this.mcpSessions.delete(sessionId);
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST, DELETE, OPTIONS" });
    }

    let payload = null;
    try { payload = await request.json(); } catch (error) {
      return jsonResponse(rpcError(null, -32700, "Parse error: request body is not valid JSON"), 400);
    }

    const batch = Array.isArray(payload);
    const messages = batch ? payload : [payload];
    const responses = [];
    let sessionId = request.headers.get("mcp-session-id") || null;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (message && message.method === "initialize" && !sessionId) {
        sessionId = randomId("mcp");
        this.mcpSessions.add(sessionId);
      }
      const response = await this.handleRpc(message);
      if (response) responses.push(response);
    }

    if (!responses.length) return new Response(null, { status: 202, headers: corsHeaders() });
    const extra = sessionId ? { "mcp-session-id": sessionId } : {};
    return jsonResponse(batch ? responses : responses[0], 200, extra);
  }

  /* ------------------------------------------------- mcp: legacy /sse */

  async handleSseOpen(request, url) {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed", message: "Open the legacy transport with GET /sse." }, 405, { allow: "GET, OPTIONS" });
    }
    const sessionId = randomId("sse");
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const session = { id: sessionId, writer: writer, encoder: new TextEncoder(), closed: false };
    this.sseSessions.set(sessionId, session);

    const presented = url.searchParams.get("api_key") || url.searchParams.get("key");
    let endpoint = "/messages?sessionId=" + encodeURIComponent(sessionId);
    if (presented) endpoint = endpoint + "&api_key=" + encodeURIComponent(presented);

    const self = this;
    if (request.signal && typeof request.signal.addEventListener === "function") {
      request.signal.addEventListener("abort", function () { self.closeSse(session); });
    }

    await this.sseRaw(session, ": connected " + nowIso() + NL + NL);
    await this.sseEvent(session, "endpoint", endpoint);
    this.startSseKeepAlive(session);

    return new Response(stream.readable, {
      status: 200,
      headers: Object.assign({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }, corsHeaders())
    });
  }

  async sseRaw(session, text) {
    if (session.closed) return false;
    try {
      await session.writer.write(session.encoder.encode(text));
      return true;
    } catch (error) {
      this.closeSse(session);
      return false;
    }
  }

  async sseEvent(session, event, data) {
    return this.sseRaw(session, "event: " + event + NL + "data: " + data + NL + NL);
  }

  closeSse(session) {
    if (session.closed) return;
    session.closed = true;
    this.sseSessions.delete(session.id);
    try { session.writer.close(); } catch (error) { /* ignore */ }
  }

  startSseKeepAlive(session) {
    const self = this;
    (async function () {
      while (!session.closed) {
        await sleep(15000);
        if (session.closed) break;
        const ok = await self.sseRaw(session, ": ping " + Date.now() + NL + NL);
        if (!ok) break;
      }
    })().catch(function () { /* ignore */ });
  }

  async handleSseMessage(request, url) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed", message: "POST JSON-RPC messages to this endpoint." }, 405, { allow: "POST, OPTIONS" });
    }
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("session_id");
    const session = sessionId ? this.sseSessions.get(sessionId) : null;
    if (!session) {
      return jsonResponse({ error: "unknown_session", message: "No open SSE stream for this sessionId. Reconnect to /sse." }, 404);
    }
    let payload = null;
    try { payload = await request.json(); } catch (error) {
      await this.sseEvent(session, "message", JSON.stringify(rpcError(null, -32700, "Parse error")));
      return new Response(null, { status: 202, headers: corsHeaders() });
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    for (let i = 0; i < messages.length; i++) {
      const response = await this.handleRpc(messages[i]);
      if (response) await this.sseEvent(session, "message", JSON.stringify(response));
    }
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  /* ------------------------------------------------------------ json rpc */

  async handleRpc(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      return rpcError(message && message.id !== undefined ? message.id : null, -32600, "Invalid Request: expected JSON-RPC 2.0");
    }
    const id = message.id;
    const isNotification = id === undefined || id === null;
    const method = String(message.method || "");

    try {
      if (method === "initialize") {
        const params = message.params || {};
        const requested = String(params.protocolVersion || DEFAULT_PROTOCOL);
        const version = SUPPORTED_PROTOCOLS.indexOf(requested) >= 0 ? requested : DEFAULT_PROTOCOL;
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "GitHub Codespace Gateway", version: SERVER_VERSION },
          instructions: [
            "This server owns exactly one shared GitHub Codespace for " + this.repoFullName() + ".",
            "run_command queues shell work; the codespace is created on first use, reused by every later command, and deleted automatically " + Math.round(this.idleTimeoutMs() / 60000) + " minutes after the last command finishes.",
            "Use get_command for long jobs, codespace_status to inspect lifecycle, keep