/*
 * MCP protocol layer: JSON-RPC 2.0 dispatch and the eight tool implementations.
 * Every function takes the CodespaceGateway durable object instance as gw.
 *
 * See util.js for the style note (no backticks, no backslash escapes).
 */

import {
  DEFAULT_PROTOCOL, DEFAULT_WAIT_MS, MAX_WAIT_MS, NL, SERVER_NAME, SERVER_VERSION,
  SUPPORTED_PROTOCOLS, classifyState, clampInt, formatCommand, rpcError, rpcResult,
  summarizeCommand, toolText
} from "./util.js";
import { TOOLS } from "./tools.js";

export async function handleRpc(gw, message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    const badId = message && message.id !== undefined ? message.id : null;
    return rpcError(badId, -32600, "Invalid Request: expected a JSON-RPC 2.0 message");
  }

  const id = message.id;
  const isNotification = id === undefined || id === null;
  const method = String(message.method || "");
  const params = message.params || {};

  try {
    if (method === "initialize") {
      const requested = String(params.protocolVersion || DEFAULT_PROTOCOL);
      const version = SUPPORTED_PROTOCOLS.indexOf(requested) >= 0 ? requested : DEFAULT_PROTOCOL;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: "GitHub Codespace Gateway", version: SERVER_VERSION },
        instructions: [
          "This server owns exactly one shared GitHub Codespace for " + gw.repoFullName() + ".",
          "run_command queues shell work. The codespace is created on first use, reused by every later command, restarted if it was stopped, and deleted automatically " + Math.round(gw.idleTimeoutMs() / 60000) + " minutes after the last command finishes.",
          "Use get_command for long jobs, list_commands to see the queue, codespace_status to inspect the lifecycle, and keep_alive to hold the box open while a human works in it.",
          "Never assume a fresh machine: state on disk persists between commands until the codespace is torn down."
        ].join(" ")
      });
    }

    if (method.indexOf("notifications/") === 0) return null;

    if (method === "ping") return isNotification ? null : rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "resources/list") return rpcResult(id, { resources: [] });
    if (method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
    if (method === "prompts/list") return rpcResult(id, { prompts: [] });
    if (method === "completion/complete") return rpcResult(id, { completion: { values: [], hasMore: false } });
    if (method === "logging/setLevel") return rpcResult(id, {});

    if (method === "tools/call") {
      const name = params.name;
      if (!name || typeof name !== "string") {
        return rpcError(id, -32602, "Invalid params: tools/call requires a tool name");
      }
      const result = await callTool(gw, name, params.arguments || {});
      return rpcResult(id, result);
    }

    if (isNotification) return null;
    return rpcError(id, -32601, "Method not found: " + method);
  } catch (error) {
    if (isNotification) return null;
    if (error && error.invalidParams) {
      return rpcError(id, -32602, "Invalid params: " + String(error.message || error));
    }
    return rpcError(id, -32603, "Internal error: " + String(error && error.message ? error.message : error));
  }
}

export async function callTool(gw, name, args) {
  try {
    if (name === "run_command") return await toolRunCommand(gw, args);
    if (name === "get_command") return await toolGetCommand(gw, args);
    if (name === "list_commands") return await toolListCommands(gw, args);
    if (name === "cancel_command") return await toolCancelCommand(gw, args);
    if (name === "codespace_status") return await toolCodespaceStatus(gw, args);
    if (name === "start_codespace") return await toolStartCodespace(gw, args);
    if (name === "stop_codespace") return await toolStopCodespace(gw, args);
    if (name === "keep_alive") return await toolKeepAlive(gw, args);
    return toolText("Unknown tool: " + name + ". Call tools/list for the available tools.", null, true);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return toolText("The gateway could not complete " + name + ": " + message, { tool: name, error: message }, true);
  }
}

/* ----------------------------------------------------------- inspection */

async function liveInspect(gw) {
  const out = { error: null, siblings: [], adopted: false };
  try {
    const list = await gw.listRepoCodespaces();
    out.siblings = list.map(function (item) {
      return {
        name: item.name,
        state: item.state,
        machine: item.machine && item.machine.name ? item.machine.name : null
      };
    });
    const ranks = ["ready", "pending", "stopped"];
    let chosen = null;
    for (let r = 0; r < ranks.length && !chosen; r++) {
      for (let i = 0; i < list.length; i++) {
        if (classifyState(list[i].state) === ranks[r]) { chosen = list[i]; break; }
      }
    }
    const tracked = gw.meta.codespace;
    if (chosen) {
      out.adopted = !tracked || tracked.name !== chosen.name;
      gw.setCodespace(chosen, false);
    } else if (tracked) {
      gw.log("codespace_gone", { name: tracked.name });
      gw.meta.codespace = null;
    }
    await gw.saveMeta();
    await gw.scheduleAlarm();
  } catch (error) {
    out.error = String(error && error.message ? error.message : error);
  }
  return out;
}

function statusLines(gw, inspect) {
  const codespace = gw.meta.codespace;
  const counts = gw.counts();
  const teardown = gw.teardownAt();
  const lines = [];
  lines.push("repository: " + gw.repoFullName());
  if (codespace) {
    lines.push("codespace: " + codespace.name + " [" + codespace.state + "]");
    lines.push("machine: " + (codespace.machine || gw.machine()) + (codespace.cores ? " (" + codespace.cores + " cores)" : ""));
    if (codespace.webUrl) lines.push("web: " + codespace.webUrl);
    lines.push("created by this gateway: " + (codespace.createdByGateway ? "yes" : "no, it was already running and got reused"));
  } else {
    lines.push("codespace: none right now, the next command will create one (" + gw.machine() + ")");
  }
  lines.push("queue: " + counts.running + " running, " + counts.queued + " queued, " + counts.total + " tracked");
  lines.push("in-codespace agent: " + (gw.agentOnline() ? "online" : "not checked in"));
  lines.push("idle timeout: " + Math.round(gw.idleTimeoutMs() / 60000) + " min");
  if (teardown === null) {
    lines.push("auto teardown: held open while work is queued or running");
  } else {
    const left = Math.max(0, teardown - Date.now());
    lines.push("auto teardown: in " + Math.round(left / 1000) + " s (" + new Date(teardown).toISOString() + ")");
  }
  if (gw.meta.keepAliveUntil && gw.meta.keepAliveUntil > Date.now()) {
    lines.push("keep alive until: " + new Date(gw.meta.keepAliveUntil).toISOString());
  }
  if (gw.meta.lastTeardown) {
    lines.push("last teardown: " + gw.meta.lastTeardown.name + " (" + gw.meta.lastTeardown.reason + ") at " + new Date(gw.meta.lastTeardown.at).toISOString());
  }
  if (inspect && inspect.siblings && inspect.siblings.length > 1) {
    lines.push("warning: " + inspect.siblings.length + " codespaces exist for this repository; the gateway drives the first live one and never creates extras.");
  }
  if (inspect && inspect.error) lines.push("github check failed: " + inspect.error);
  return lines;
}

/* ---------------------------------------------------------------- tools */

async function toolCodespaceStatus(gw) {
  const inspect = await liveInspect(gw);
  const lines = statusLines(gw, inspect);
  const recent = gw.recentCommands(5, "all");
  if (recent.length) {
    lines.push("");
    lines.push("recent commands:");
    for (let i = 0; i < recent.length; i++) {
      const item = recent[i];
      lines.push("  " + item.id + "  " + item.status + (item.exitCode === null ? "" : " (exit " + item.exitCode + ")") + "  " + item.command);
    }
  }
  return toolText(lines.join(NL), {
    state: gw.publicState(),
    live: { siblings: inspect.siblings, error: inspect.error }
  }, false);
}

async function toolRunCommand(gw, args) {
  const wait = args.wait === undefined || args.wait === null ? true : !!args.wait;
  const waitMs = clampInt(args.wait_ms, 1000, MAX_WAIT_MS, DEFAULT_WAIT_MS);

  const cmd = await gw.enqueue({
    command: args.command,
    cwd: args.cwd,
    timeoutMs: args.timeout_ms,
    source: "mcp"
  });

  const lines = [];
  let ensureError = null;
  try {
    const ensured = await gw.ensureCodespace();
    const codespace = ensured.codespace;
    const verb = ensured.action === "created" ? "created" : (ensured.action === "started" ? "restarted" : "reused");
    lines.push("codespace " + verb + ": " + codespace.name + " [" + codespace.state + "] on " + (codespace.machine || gw.machine()));
  } catch (error) {
    ensureError = String(error && error.message ? error.message : error);
    lines.push("codespace warning: " + ensureError + " (the command stays queued and the gateway retries every 30 s)");
  }

  if (!gw.agentOnline()) {
    lines.push("note: the in-codespace agent has not checked in yet. Commands run as soon as it starts polling; a brand new codespace usually needs a minute.");
  }

  const final = wait ? await gw.waitForCommand(cmd.id, waitMs) : cmd;
  const resolved = final || cmd;
  lines.push("");
  lines.push(formatCommand(resolved));

  return toolText(
    lines.join(NL),
    { command: summarizeCommand(resolved, 8000), codespace: gw.meta.codespace, counts: gw.counts(), ensureError: ensureError },
    resolved.status === "error"
  );
}

async function toolGetCommand(gw, args) {
  const id = args.command_id;
  if (!id) {
    const error = new Error("command_id is required");
    error.invalidParams = true;
    throw error;
  }
  const waitMs = clampInt(args.wait_ms, 0, MAX_WAIT_MS, 0);
  const cmd = waitMs > 0 ? await gw.waitForCommand(String(id), waitMs) : gw.commands.get(String(id));
  if (!cmd) {
    return toolText("No command with id " + id + ". It may have aged out of the " + gw.order.length + " tracked commands.", null, true);
  }
  return toolText(formatCommand(cmd), { command: summarizeCommand(cmd, 8000) }, cmd.status === "error");
}

async function toolListCommands(gw, args) {
  const limit = clampInt(args.limit, 1, 100, 20);
  const status = args.status ? String(args.status) : "all";
  const items = gw.recentCommands(limit, status);
  const counts = gw.counts();
  const lines = [];
  lines.push(counts.running + " running, " + counts.queued + " queued, " + counts.total + " tracked (filter: " + status + ")");
  if (!items.length) {
    lines.push("no commands match");
  } else {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const when = new Date(item.createdAt).toISOString();
      const took = item.durationMs === null ? "" : " in " + (item.durationMs / 1000).toFixed(1) + " s";
      lines.push(when + "  " + item.id + "  " + item.status + (item.exitCode === null ? "" : " (exit " + item.exitCode + ")") + took);
      lines.push("    " + item.command);
    }
  }
  return toolText(lines.join(NL), { counts: counts, commands: items }, false);
}

async function toolCancelCommand(gw, args) {
  const id = args.command_id;
  if (!id) {
    const error = new Error("command_id is required");
    error.invalidParams = true;
    throw error;
  }
  const cmd = await gw.cancelCommand(String(id));
  if (!cmd) return toolText("No command with id " + id + ".", null, true);
  if (cmd.status === "canceled") return toolText("Command " + cmd.id + " was canceled before it started.", { command: summarizeCommand(cmd) }, false);
  if (cmd.status === "canceling") {
    return toolText(
      "Cancellation requested for " + cmd.id + ". The in-codespace agent kills the process on its next heartbeat (within about 20 s).",
      { command: summarizeCommand(cmd) },
      false
    );
  }
  return toolText("Command " + cmd.id + " already finished with status " + cmd.status + ".", { command: summarizeCommand(cmd) }, false);
}

async function toolStartCodespace(gw, args) {
  const ensured = await gw.ensureCodespace();
  let codespace = ensured.codespace;
  if (args.wait_for_ready) {
    codespace = await gw.waitForReady(clampInt(args.wait_ms, 1000, MAX_WAIT_MS, DEFAULT_WAIT_MS)) || codespace;
  }
  const lines = [];
  const verb = ensured.action === "created" ? "Created a new codespace" : (ensured.action === "started" ? "Restarted the stopped codespace" : "Reused the existing codespace");
  lines.push(verb + ": " + codespace.name + " [" + codespace.state + "]");
  lines.push("machine: " + (codespace.machine || gw.machine()) + (codespace.cores ? " (" + codespace.cores + " cores)" : ""));
  if (codespace.webUrl) lines.push("web: " + codespace.webUrl);
  lines.push("");
  const rest = statusLines(gw, null);
  for (let i = 0; i < rest.length; i++) lines.push(rest[i]);
  return toolText(lines.join(NL), { action: ensured.action, codespace: codespace, state: gw.publicState() }, false);
}

async function toolStopCodespace(gw, args) {
  const mode = args.mode === "stop" ? "stop" : "delete";
  const counts = gw.counts();
  if (!args.force && (counts.queued > 0 || counts.running > 0)) {
    return toolText(
      "Refusing to tear down: " + counts.running + " running and " + counts.queued + " queued commands. Pass force true to override, or wait for the idle timer.",
      { counts: counts },
      true
    );
  }
  if (!gw.meta.codespace) {
    return toolText("There is no codespace to tear down right now.", { state: gw.publicState() }, false);
  }
  const result = await gw.teardown(args.force ? "forced through stop_codespace" : "requested through stop_codespace", mode);
  const verb = mode === "stop" ? "Stopped" : "Deleted";
  return toolText(verb + " codespace " + result.name + ".", { result: result, state: gw.publicState() }, false);
}

async function toolKeepAlive(gw, args) {
  const minutes = clampInt(args.minutes, 1, 240, 15);
  gw.meta.keepAliveUntil = Date.now() + minutes * 60000;
  gw.log("keep_alive", { minutes: minutes });
  await gw.saveMeta();
  await gw.scheduleAlarm();
  const teardown = gw.teardownAt();
  const lines = [];
  lines.push("Idle teardown pushed back by " + minutes + " minutes (until " + new Date(gw.meta.keepAliveUntil).toISOString() + ").");
  if (teardown !== null) lines.push("Next teardown check resolves at " + new Date(teardown).toISOString() + " if nothing new arrives.");
  if (!gw.meta.codespace) lines.push("Note: no codespace is running right now, so this only matters once one starts.");
  return toolText(lines.join(NL), { keepAliveUntil: gw.meta.keepAliveUntil, teardownAt: teardown }, false);
}
