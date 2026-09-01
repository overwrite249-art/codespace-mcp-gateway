/* Minimal GitHub Codespaces REST client. See util.js for the style note. */

import { GITHUB_API, SERVER_NAME, SERVER_VERSION, classifyState, sleep, truncateText } from "./util.js";

export async function ghRequest(env, method, path, body, attempt) {
  const tries = attempt || 0;
  const init = {
    method: method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + env.GITHUB_TOKEN,
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
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      data = { message: truncateText(text, 400).text };
    }
  }

  const retryable = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
  if (retryable && tries < 2) {
    await sleep(600 * (tries + 1));
    return ghRequest(env, method, path, body, tries + 1);
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

export function normalizeCodespace(raw, previous, createdByGateway) {
  const same = previous && previous.name === raw.name;
  const ready = classifyState(raw.state) === "ready";
  return {
    name: raw.name,
    state: raw.state,
    stateClass: classifyState(raw.state),
    displayName: raw.display_name || null,
    machine: raw.machine && raw.machine.name ? raw.machine.name : null,
    cores: raw.machine && raw.machine.cpus ? raw.machine.cpus : null,
    memoryMb: raw.machine && raw.machine.memory_in_bytes ? Math.round(raw.machine.memory_in_bytes / 1048576) : null,
    repository: raw.repository && raw.repository.full_name ? raw.repository.full_name : null,
    webUrl: raw.web_url || null,
    ref: raw.git_status && raw.git_status.ref ? raw.git_status.ref : null,
    createdAt: same && previous.createdAt ? previous.createdAt : Date.now(),
    readyAt: ready ? (same && previous.readyAt ? previous.readyAt : Date.now()) : null,
    lastCheckedAt: Date.now(),
    createdByGateway: createdByGateway ? true : (same ? !!previous.createdByGateway : false)
  };
}
