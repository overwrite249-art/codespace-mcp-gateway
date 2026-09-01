/* MCP tool catalog exposed by the gateway. See util.js for the style note. */

export const TOOLS = [
  {
    name: "run_command",
    title: "Run a shell command in the shared codespace",
    description: "Queue a shell command for the single shared GitHub Codespace and wait for its output. Creates the codespace on first use, restarts it if it was stopped, and reuses the running one for every later command. Long jobs keep running after the wait window expires, so poll get_command with the returned id.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command, executed with bash -lc inside the codespace." },
        cwd: { type: "string", description: "Optional working directory. Defaults to the repository checkout under /workspaces." },
        timeout_ms: { type: "integer", description: "Hard kill timeout for the process inside the codespace. Default 600000, max 3600000." },
        wait: { type: "boolean", description: "Wait for the result instead of returning immediately. Default true." },
        wait_ms: { type: "integer", description: "How long this call waits for the result. Default 60000, max 90000." }
      },
      required: ["command"],
      additionalProperties: false
    },
    annotations: { title: "Run command in codespace", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "get_command",
    title: "Get a queued or finished command",
    description: "Fetch the status and full captured output of a previously queued command, optionally blocking until it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", description: "Identifier returned by run_command." },
        wait_ms: { type: "integer", description: "Optionally block up to this long for completion. Default 0, max 90000." }
      },
      required: ["command_id"],
      additionalProperties: false
    },
    annotations: { title: "Get command result", readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "list_commands",
    title: "List recent commands",
    description: "List recent commands with status, exit code and output previews so you can see what is queued or still running on the shared codespace.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many commands to return, newest first. Default 20, max 100." },
        status: {
          type: "string",
          enum: ["queued", "running", "done", "error", "canceled", "active", "all"],
          description: "Filter by status. active means queued or running. Default all."
        }
      },
      additionalProperties: false
    },
    annotations: { title: "List commands", readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "cancel_command",
    title: "Cancel a command",
    description: "Drop a queued command, or ask the in-codespace agent to kill a running one.",
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
    description: "Tear the shared codespace down immediately instead of waiting for the idle timer. Mode delete calls DELETE /user/codespaces/{name}; mode stop only shuts it down so it can be restarted later.",
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
    description: "Push back the idle auto-teardown deadline, for example while a human is working inside the codespace.",
    inputSchema: {
      type: "object",
      properties: { minutes: { type: "integer", description: "Minutes to keep the codespace alive from now. Default 15, max 240." } },
      additionalProperties: false
    },
    annotations: { title: "Keep alive", readOnlyHint: false, idempotentHint: false }
  }
];
