/*
 * CodespaceGateway durable object.
 *
 * One instance owns the whole lifecycle: it is the single writer for the
 * shared codespace, the command queue, the idle timer and the SSE sessions.
 * Because every request is routed to idFromName("global-codespace-gateway"),
 * concurrent commands can never create two codespaces.
 *
 * See util.js for the style note (no backticks, no backslash escapes).
 */

import {
  AGENT_HOLD_MS, AGENT_OFFLINE_MS, ALARM_INTERVAL_MS, DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MACHINE, DEFAULT_WAIT_MS, MAX_COMMAND_TIMEOUT_MS,
  MAX_EVENTS, MAX_HISTORY, MAX_OUTPUT_CHARS, MAX_WAIT_MS, NL, RUNNING_STALE_MS,
  SERVER_NAME, SERVER_VERSION, classifyState, clampInt, corsHeaders, intOr, isTerminalStatus,
  jsonResponse, nowIso, randomId, rpcError, sleep, summarizeCommand, truncateText
} from "./util.js";
import { ghRequest, normalizeCodespace } from "./github.js";
import { handleRpc } from "./mcp.js";

export class CodespaceGateway {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.meta = null;
    this.commands = new Map();
    this.order = [];
    this.commandWaiters = new Map();
    this.workWaiters = [];
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

  async readJson(request) {
    try {
      const value = await request.json();
      return value && typeof value === "object" ? value : {};
    } catch (error) { return {}; }
  }

  /* -------------------------------------------------------------- config */

  machine() { return this.env.CODESPACE_MACHINE || DEFAULT_MACHINE; }

  idleTimeoutMs() { return clampInt(this.env.IDLE_TIMEOUT_MS, 60000, 86400000, DEFAULT_IDLE_TIMEOUT_MS); }

  repoFullName() { return String(this.env.REPO_OWNER) + "/" + String(this.env.REPO_NAME); }

  gh(method, path, body) { return ghRequest(this.env, method, path, body); }

  /* --------------------------------------------------- codespace control */

  async listRepoCodespaces() {
    const listed = await this.gh("GET", "/user/codespaces?per_page=100");
    const all = listed && listed.codespaces ? listed.codespaces : [];
    const wanted = this.repoFullName().toLowerCase();
    return all.filter(function (item) {
      const full = item && item.repository && item.repository.full_name ? String(item.repository.full_name).toLowerCase() : "";
      return full === wanted;
    });
  }

  setCodespace(raw, createdByGateway) {
    this.meta.codespace = normalizeCodespace(raw, this.meta.codespace, createdByGateway);
    if (!this.meta.codespace.repository) this.meta.codespace.repository = this.repoFullName();
    return this.meta.codespace;
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
    const ranks = ["ready", "pending", "stopped"];
    let chosen = null;
    for (let r = 0; r < ranks.length && !chosen; r++) {
      for (let i = 0; i < existing.length; i++) {
        if (classifyState(existing[i].state) === ranks[r]) { chosen = existing[i]; break; }
      }
    }

    let action = "reused";
    if (!chosen) {
      const body = {
        machine: this.machine(),
        idle_timeout_minutes: clampInt(this.env.CODESPACE_IDLE_MINUTES, 5, 240, 30),
        retention_period_minutes: clampInt(this.env.CODESPACE_RETENTION_MINUTES, 0, 43200, 120)
      };
      if (this.env.REPO_REF) body.ref = this.env.REPO_REF;
      if (this.env.DEVCONTAINER_PATH) body.devcontainer_path = this.env.DEVCONTAINER_PATH;
      const created = await this.gh("POST", "/repos/" + this.env.REPO_OWNER + "/" + this.env.REPO_NAME + "/codespaces", body);
      this.setCodespace(created, true);
      action = "created";
      this.log("codespace_created", { name: created.name, machine: this.machine(), state: created.state });
    } else if (classifyState(chosen.state) === "stopped") {
      const started = await this.gh("POST", "/user/codespaces/" + chosen.name + "/start");
      this.setCodespace(started, false);
      action = "started";
      this.log("codespace_started", { name: started.name, state: started.state });
    } else {
      const previous = this.meta.codespace;
      this.setCodespace(chosen, false);
      if (!previous || previous.name !== chosen.name) {
        this.log("codespace_adopted", { name: chosen.name, state: chosen.state });
      }
      action = "reused";
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
      const before = current.state;
      this.setCodespace(raw, false);
      if (classifyState(raw.state) === "dead") {
        this.log("codespace_lost", { name: current.name, state: raw.state });
        this.meta.codespace = null;
      } else if (before !== raw.state) {
        this.log("codespace_state", { name: current.name, from: before, to: raw.state });
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
    const budget = clampInt(waitMs, 1000, MAX_WAIT_MS, DEFAULT_WAIT_MS);
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      const current = this.meta.codespace;
      if (current && classifyState(current.state) === "ready") return current;
      await sleep(3000);
      if (this.meta.codespace) await this.refreshCodespace();
      if (!this.meta.codespace) {
        try { await this.ensureCodespace(); } catch (error) { break; }
      }
    }
    return this.meta.codespace;
  }

  /* ----------------------------------------------------------- queue view */

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
    return Math.max(this.idleBaseline() + this.idleTimeoutMs(), this.meta.keepAliveUntil || 0);
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
    this.wakeWorkWaiters();
    return cmd;
  }

  wakeWorkWaiters() {
    const waiters = this.workWaiters;
    this.workWaiters = [];
    for (let i = 0; i < waiters.length; i++) {
      try { waiters[i](); } catch (error) { /* ignore */ }
    }
  }

  waitForWork(ms) {
    const self = this;
    return new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        const index = self.workWaiters.indexOf(waiter);
        if (index >= 0) self.workWaiters.splice(index, 1);
        resolve();
      }, ms);
      function waiter() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      }
      self.workWaiters.push(waiter);
    });
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
      let done = false;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        const list = self.commandWaiters.get(id) || [];
        const index = list.indexOf(waiter);
        if (index >= 0) list.splice(index, 1);
        resolve(self.commands.get(id) || null);
      }, budget);
      function waiter(cmd) {
        if (done) return;
        done = true;
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
    cmd.status = payload.canceled ? "canceled" : (payload.error ? "error" : "done");
    if (payload.canceled && !cmd.error) cmd.error = "canceled";
    this.meta.lastFinishAt = cmd.finishedAt;
    this.log("command_finished", { id: cmd.id, status: cmd.status, exitCode: cmd.exitCode });
    await this.saveCommand(cmd);
    await this.saveMeta();
    await this.scheduleAlarm();
    this.resolveCommandWaiters(cmd);
    return cmd;
  }

  async cancelCommand(id) {
    const cmd = this.commands.get(id);
    if (!cmd) return null;
    if (isTerminalStatus(cmd.status)) return cmd;
    if (cmd.status === "queued") {
      cmd.status = "canceled";
      cmd.error = "canceled before it started";
      cmd.finishedAt = Date.now();
      this.meta.lastFinishAt = cmd.finishedAt;
      this.log("command_canceled", { id: cmd.id });
      await this.saveCommand(cmd);
      await this.saveMeta();
      await this.scheduleAlarm();
      this.resolveCommandWaiters(cmd);
      return cmd;
    }
    cmd.cancelRequested = true;
    cmd.status = "canceling";
    this.log("command_cancel_requested", { id: cmd.id });
    await this.saveCommand(cmd);
    await this.saveMeta();
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

  /* ------------------------------------------------------------ teardown */

  async teardown(reason, mode) {
    const codespace = this.meta.codespace;
    if (!codespace) return { ok: false, message: "No codespace is currently tracked." };
    const name = codespace.name;
    const stopOnly = mode === "stop";
    try {
      if (stopOnly) await this.gh("POST", "/user/codespaces/" + name + "/stop");
      else await this.gh("DELETE", "/user/codespaces/" + name);
    } catch (error) {
      if (!(error && error.status === 404)) {
        this.log("teardown_failed", { name: name, reason: reason, message: String(error && error.message ? error.message : error) });
        await this.saveMeta();
        throw error;
      }
    }
    this.log(stopOnly ? "codespace_stopped" : "codespace_deleted", { name: name, reason: reason });
    this.meta.lastTeardown = { name: name, reason: reason, mode: stopOnly ? "stop" : "delete", at: Date.now() };
    this.meta.codespace = null;
    this.meta.keepAliveUntil = 0;
    this.meta.agentSeenAt = 0;
    await this.saveMeta();
    await this.scheduleAlarm();
    return { ok: true, name: name, mode: stopOnly ? "stop" : "delete", reason: reason };
  }

  async maybeTeardown() {
    const at = this.teardownAt();
    if (at === null || Date.now() < at) return null;
    try {
      return await this.teardown("idle for " + Math.round(this.idleTimeoutMs() / 60000) + " minutes", "delete");
    } catch (error) { return null; }
  }

  async requeueStaleCommands() {
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < this.order.length; i++) {
      const cmd = this.commands.get(this.order[i]);
      if (!cmd || (cmd.status !== "running" && cmd.status !== "canceling")) continue;
      const seen = cmd.agentSeenAt || cmd.startedAt || cmd.createdAt;
      const limit = Math.max(RUNNING_STALE_MS, (cmd.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS) + 120000);
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
        try {
          await this.ensureCodespace();
        } catch (error) {
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
    const path = url.pathname.charAt(url.pathname.length - 1) === "/" && url.pathname.length > 1
      ? url.pathname.slice(0, -1)
      : url.pathname;
    try {
      if (path === "/mcp") return await this.handleMcp(request);
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
      }, 500);
    }
  }

  /* ---------------------------------------------------- transport: /mcp */

  async handleMcp(request) {
    if (request.method === "GET") {
      return jsonResponse({
        error: "method_not_allowed",
        message: "This server does not open server-initiated streams on GET /mcp. POST JSON-RPC to /mcp, or use the legacy /sse transport."
      }, 405, { allow: "POST, DELETE, OPTIONS" });
    }
    if (request.method === "DELETE") {
      const sid = request.headers.get("mcp-session-id");
      if (sid) this.mcpSessions.delete(sid);
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST, DELETE, OPTIONS" });
    }

    let payload = null;
    try {
      payload = await request.json();
    } catch (error) {
      return jsonResponse(rpcError(null, -32700, "Parse error: body is not valid JSON"), 400);
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
      const response = await handleRpc(this, message);
      if (response) responses.push(response);
    }

    if (!responses.length) return new Response(null, { status: 202, headers: corsHeaders() });
    return jsonResponse(batch ? responses : responses[0], 200, sessionId ? { "mcp-session-id": sessionId } : {});
  }

  /* -------------------------------------------- transport: legacy /sse */

  async handleSseOpen(request, url) {
    if (request.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed", message: "Open the legacy transport with GET /sse." }, 405, { allow: "GET, OPTIONS" });
    }
    const sessionId = randomId("sse");
    const stream = new TransformStream();
    const session = { id: sessionId, writer: stream.writable.getWriter(), encoder: new TextEncoder(), closed: false };
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

  sseEvent(session, event, data) {
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
      return jsonResponse({ error: "method_not_allowed", message: "POST JSON-RPC messages here." }, 405, { allow: "POST, OPTIONS" });
    }
    const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("session_id");
    const session = sessionId ? this.sseSessions.get(sessionId) : null;
    if (!session) {
      return jsonResponse({ error: "unknown_session", message: "No open SSE stream for this sessionId. Reconnect to /sse." }, 404);
    }
    let payload = null;
    try {
      payload = await request.json();
    } catch (error) {
      await this.sseEvent(session, "message", JSON.stringify(rpcError(null, -32700, "Parse error")));
      return new Response(null, { status: 202, headers: corsHeaders() });
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    for (let i = 0; i < messages.length; i++) {
      const response = await handleRpc(this, messages[i]);
      if (response) await this.sseEvent(session, "message", JSON.stringify(response));
    }
    return new Response(null, { status: 202, headers: corsHeaders() });
  }

  /* ------------------------------------------------------- dashboard api */

  async handleApiRun(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
    const body = await this.readJson(request);
    let cmd;
    try {
      cmd = await this.enqueue({
        command: body.command,
        cwd: body.cwd,
        timeoutMs: body.timeout_ms,
        source: "dashboard"
      });
    } catch (error) {
      return jsonResponse({ error: "invalid_request", message: String(error && error.message ? error.message : error) }, 400);
    }
    let ensureError = null;
    try {
      await this.ensureCodespace();
    } catch (error) {
      ensureError = String(error && error.message ? error.message : error);
    }
    const finished = await this.waitForCommand(cmd.id, clampInt(body.wait_ms, 0, MAX_WAIT_MS, 45000));
    return jsonResponse({
      command: summarizeCommand(finished || cmd, 4000),
      stdout: (finished || cmd).stdout,
      stderr: (finished || cmd).stderr,
      ensureError: ensureError,
      state: this.publicState()
    });
  }

  async handleApiCommand(request, url) {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "invalid_request", message: "Pass ?id=<command id>" }, 400);
    const waitMs = clampInt(url.searchParams.get("wait_ms"), 0, MAX_WAIT_MS, 0);
    const cmd = waitMs > 0 ? await this.waitForCommand(id, waitMs) : this.commands.get(id);
    if (!cmd) return jsonResponse({ error: "not_found", message: "Unknown command id " + id }, 404);
    return jsonResponse({ command: summarizeCommand(cmd, 4000), stdout: cmd.stdout, stderr: cmd.stderr });
  }

  async handleApiKeepAlive(request) {
    const body = await this.readJson(request);
    const minutes = clampInt(body.minutes, 1, 240, 15);
    this.meta.keepAliveUntil = Date.now() + minutes * 60000;
    this.log("keep_alive", { minutes: minutes });
    await this.saveMeta();
    await this.scheduleAlarm();
    return jsonResponse({ ok: true, minutes: minutes, keepAliveUntil: this.meta.keepAliveUntil, state: this.publicState() });
  }

  async handleApiTeardown(request, url) {
    const body = await this.readJson(request);
    const mode = (body.mode || url.searchParams.get("mode")) === "stop" ? "stop" : "delete";
    const force = body.force === true || url.searchParams.get("force") === "true";
    const active = this.counts();
    if (!force && (active.queued > 0 || active.running > 0)) {
      return jsonResponse({
        error: "busy",
        message: "There are " + active.running + " running and " + active.queued + " queued commands. Pass force to tear down anyway.",
        counts: active
      }, 409);
    }
    try {
      const result = await this.teardown("requested from the dashboard", mode);
      return jsonResponse({ ok: !!result.ok, result: result, state: this.publicState() });
    } catch (error) {
      return jsonResponse({ error: "teardown_failed", message: String(error && error.message ? error.message : error) }, 502);
    }
  }

  /* ------------------------------------------------------ agent protocol */

  agentEnvelope() {
    return {
      cancel: this.pendingCancels(),
      idleTeardownAt: this.teardownAt(),
      idleTimeoutMs: this.idleTimeoutMs(),
      heartbeatIntervalMs: 20000,
      pollHoldMs: AGENT_HOLD_MS,
      counts: this.counts()
    };
  }

  async touchAgent(body) {
    this.meta.agentSeenAt = Date.now();
    if (body && (body.agent_id || body.agentId)) this.meta.agentId = String(body.agent_id || body.agentId);
    await this.saveMeta();
  }

  async handleAgentPoll(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
    const body = await this.readJson(request);
    await this.touchAgent(body);

    const reported = body.codespace || body.codespace_name || null;
    const current = this.meta.codespace;
    if (reported && current && current.name !== reported) {
      return jsonResponse(Object.assign({ command: null, stop: true, reason: "a different codespace is active: " + current.name }, this.agentEnvelope()));
    }
    if (reported && !current) {
      return jsonResponse(Object.assign({ command: null, stop: true, reason: "the gateway is no longer tracking a codespace" }, this.agentEnvelope()));
    }

    const deadline = Date.now() + AGENT_HOLD_MS;
    while (true) {
      const claimed = await this.claimNextCommand(body.agent_id || body.agentId || null);
      if (claimed) {
        return jsonResponse(Object.assign({
          command: { id: claimed.id, command: claimed.command, cwd: claimed.cwd, timeout_ms: claimed.timeoutMs }
        }, this.agentEnvelope()));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return jsonResponse(Object.assign({ command: null }, this.agentEnvelope()));
      await this.waitForWork(Math.min(remaining, 5000));
    }
  }

  async handleAgentResult(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
    const body = await this.readJson(request);
    await this.touchAgent(body);
    const id = body.command_id || body.commandId;
    if (!id) return jsonResponse({ error: "invalid_request", message: "command_id is required" }, 400);
    const cmd = await this.completeCommand(String(id), {
      exitCode: body.exit_code === undefined ? body.exitCode : body.exit_code,
      stdout: body.stdout,
      stderr: body.stderr,
      error: body.error,
      canceled: body.canceled === true,
      truncated: body.truncated === true
    });
    if (!cmd) return jsonResponse({ error: "not_found", message: "Unknown command id " + id }, 404);
    return jsonResponse(Object.assign({ ok: true, status: cmd.status }, this.agentEnvelope()));
  }

  async handleAgentHeartbeat(request) {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
    const body = await this.readJson(request);
    await this.touchAgent(body);
    const ids = Array.isArray(body.command_ids) ? body.command_ids : (Array.isArray(body.commandIds) ? body.commandIds : []);
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      const cmd = this.commands.get(String(ids[i]));
      if (cmd && (cmd.status === "running" || cmd.status === "canceling")) {
        cmd.agentSeenAt = Date.now();
        await this.saveCommand(cmd);
        changed = true;
      }
    }
    if (changed) await this.saveMeta();
    return jsonResponse(Object.assign({ ok: true }, this.agentEnvelope()));
  }
}
