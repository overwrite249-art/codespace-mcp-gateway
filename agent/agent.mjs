#!/usr/bin/env node
/*
 * In-codespace agent.
 *
 * The Worker cannot open a shell inside a codespace, so this process runs the
 * other half of the loop: it long-polls the gateway for queued commands, runs
 * them in a real shell, streams the results back, and honours cancellations.
 *
 * It needs two secrets, injected as Codespaces secrets:
 *   MCP_GATEWAY_URL   https://codespace-mcp-gateway.<subdomain>.workers.dev
 *   MCP_AGENT_KEY     AGENT_TOKEN if you set one, otherwise MCP_API_KEY
 *
 * Optional:
 *   MCP_AGENT_CONCURRENCY  parallel commands (default 2)
 *   MCP_AGENT_CWD          default working directory
 *   MCP_AGENT_SHELL        default bash
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

const GATEWAY = String(process.env.MCP_GATEWAY_URL || "").replace(/\/+$/, "");
const KEY = process.env.MCP_AGENT_KEY || "";
const CONCURRENCY = Math.max(1, Number(process.env.MCP_AGENT_CONCURRENCY || 2) || 2);
const SHELL = process.env.MCP_AGENT_SHELL || "bash";
const WORKDIR = process.env.MCP_AGENT_CWD || process.env.GITHUB_WORKSPACE || process.cwd();
const CODESPACE = process.env.CODESPACE_NAME || null;
const AGENT_ID = (process.env.HOSTNAME || "agent") + "-" + randomUUID().slice(0, 8);
const MAX_CHARS = 60000;

if (!GATEWAY || !KEY) {
  console.error("[agent] MCP_GATEWAY_URL and MCP_AGENT_KEY must be set. Run scripts/provision-codespace-secrets.sh, then rebuild the codespace.");
  process.exit(1);
}

/** id -> { child, canceled, timedOut } */
const running = new Map();
let heartbeatMs = 20000;
let shuttingDown = false;
let backoff = 1000;

function log(...parts) {
  console.log(new Date().toISOString(), "[agent]", ...parts);
}

function cap(text) {
  const value = String(text == null ? "" : text);
  if (value.length <= MAX_CHARS) return { text: value, truncated: false };
  const half = Math.floor(MAX_CHARS / 2);
  return {
    text: value.slice(0, half) + "\n... [" + (value.length - MAX_CHARS) + " characters trimmed by the agent] ...\n" + value.slice(-half),
    truncated: true
  };
}

async function post(path, body, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GATEWAY + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error("HTTP " + res.status + ": " + text.slice(0, 200));
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function hardKill(job) {
  try { job.child.kill("SIGTERM"); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    try { job.child.kill("SIGKILL"); } catch { /* already gone */ }
  }, 5000);
  if (typeof timer.unref === "function") timer.unref();
}

function applyEnvelope(envelope) {
  if (!envelope) return;
  if (typeof envelope.heartbeatIntervalMs === "number" && envelope.heartbeatIntervalMs >= 5000) {
    heartbeatMs = envelope.heartbeatIntervalMs;
  }
  const cancels = Array.isArray(envelope.cancel) ? envelope.cancel : [];
  for (const id of cancels) {
    const job = running.get(id);
    if (job && !job.canceled) {
      job.canceled = true;
      log("cancelling", id);
      hardKill(job);
    }
  }
}

function execute(task) {
  const started = Date.now();
  let child;
  try {
    child = spawn(SHELL, ["-lc", task.command], {
      cwd: task.cwd || WORKDIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    return post("/agent/result", {
      agent_id: AGENT_ID,
      command_id: task.id,
      exit_code: null,
      stdout: "",
      stderr: "",
      error: "could not start the shell: " + String(error && error.message ? error.message : error)
    }).then(applyEnvelope, (err) => log("result failed", err.message));
  }

  const job = { child, canceled: false, timedOut: false };
  running.set(task.id, job);
  log("running", task.id, JSON.stringify(task.command.slice(0, 120)));

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const limit = Number(task.timeout_ms) > 0 ? Number(task.timeout_ms) : 600000;
  const timeoutTimer = setTimeout(() => {
    job.timedOut = true;
    log("timeout", task.id, limit + "ms");
    hardKill(job);
  }, limit);

  return new Promise((resolve) => {
    let settled = false;
    const finish = async (exitCode, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      running.delete(task.id);

      const out = cap(stdout);
      const err = cap(stderr);
      let failure = null;
      if (spawnError) failure = String(spawnError.message || spawnError);
      else if (job.timedOut) failure = "timed out after " + limit + " ms and was killed";

      log("finished", task.id, "exit=" + exitCode, ((Date.now() - started) / 1000).toFixed(1) + "s");

      try {
        const envelope = await post("/agent/result", {
          agent_id: AGENT_ID,
          command_id: task.id,
          exit_code: exitCode,
          stdout: out.text,
          stderr: err.text,
          error: failure,
          canceled: job.canceled,
          truncated: out.truncated || err.truncated
        });
        applyEnvelope(envelope);
      } catch (error) {
        log("could not report", task.id, error.message);
      }
      resolve();
    };

    child.on("error", (error) => finish(null, error));
    child.on("close", (code, signal) => finish(code === null && signal ? null : code, null));
  });
}

async function heartbeatLoop() {
  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, heartbeatMs));
    if (shuttingDown || running.size === 0) continue;
    try {
      applyEnvelope(await post("/agent/heartbeat", {
        agent_id: AGENT_ID,
        codespace: CODESPACE,
        command_ids: [...running.keys()]
      }, 20000));
    } catch (error) {
      log("heartbeat failed", error.message);
    }
  }
}

async function pollLoop() {
  log("starting", AGENT_ID, "->", GATEWAY, "concurrency", CONCURRENCY, "cwd", WORKDIR);
  while (!shuttingDown) {
    if (running.size >= CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      const reply = await post("/agent/poll", {
        agent_id: AGENT_ID,
        codespace: CODESPACE,
        running: [...running.keys()]
      }, 60000);
      backoff = 1000;
      applyEnvelope(reply);

      if (reply.stop) {
        log("gateway asked this agent to stop:", reply.reason || "no reason given");
        shuttingDown = true;
        break;
      }
      if (reply.command) {
        execute(reply.command);
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        log("auth rejected, check MCP_AGENT_KEY. Retrying in 30s.");
        await new Promise((r) => setTimeout(r, 30000));
      } else {
        log("poll failed:", error.message, "retrying in", backoff + "ms");
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
  log("poll loop exited");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("received", signal, "- shutting down");
    shuttingDown = true;
    for (const job of running.values()) hardKill(job);
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

heartbeatLoop();
pollLoop().catch((error) => {
  console.error("[agent] fatal", error);
  process.exit(1);
});
