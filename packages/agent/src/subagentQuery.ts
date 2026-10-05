import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  incrementTaskTokenUsage,
  updateTaskHeartbeat,
  saveTaskSessionId,
  getTaskSessionId,
} from "@aif/data";
import { getEnv, logger, modelOption } from "@aif/shared";
import { createActivityLogger, createSubagentLogger, logActivity, getClaudePath } from "./hooks.js";
import { writeQueryAudit } from "./queryAudit.js";
import {
  createClaudeStderrCollector,
  explainClaudeFailure,
  probeClaudeCliFailure,
} from "./claudeDiagnostics.js";
import { PROJECT_SCOPE_SYSTEM_APPEND } from "./constants.js";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const log = logger("subagent-query");

const HEARTBEAT_INTERVAL_MS = 30_000;
const QUERY_START_TIMEOUT_CODE = "query_start_timeout";

export interface SubagentQueryOptions {
  taskId: string;
  projectRoot: string;
  agentName: string;
  prompt: string;
  maxBudgetUsd?: number | null;
  /** Agent definition name for extraArgs. Omit for skill-based invocations (e.g. isFix planner). */
  agent?: string;
  /** Claude model to use. Falls back to Claude Code default when unset. */
  model?: string;
  /** Additional SubagentStart hooks beyond the default activity/subagent loggers. */
  extraSubagentStartHooks?: HookCallback[];
  /** Whether to skip code review stage (implementing → done instead of implementing → review). */
  skipReview?: boolean;
  /** Optional override for tests/tuning: timeout waiting for first message from query stream. */
  queryStartTimeoutMs?: number;
  /** Optional override for tests/tuning: delay before retrying after query_start_timeout. */
  queryStartRetryDelayMs?: number;
}

export interface SubagentQueryResult {
  resultText: string;
}

interface QueryStartTimeoutError extends Error {
  code: typeof QUERY_START_TIMEOUT_CODE;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isQueryStartTimeoutError(err: unknown): err is QueryStartTimeoutError {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === QUERY_START_TIMEOUT_CODE,
  );
}

function makeQueryStartTimeoutError(agentName: string, timeoutMs: number): QueryStartTimeoutError {
  const err = new Error(
    `query_start_timeout: ${agentName} produced no output within ${timeoutMs}ms`,
  ) as QueryStartTimeoutError;
  err.code = QUERY_START_TIMEOUT_CODE;
  return err;
}

function processQueryMessage(
  message: Awaited<ReturnType<AsyncIterator<unknown>["next"]>>["value"],
  taskId: string,
  agentName: string,
  setResultText: (value: string) => void,
): void {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  const typed = message as {
    type: string;
    subtype?: string;
    session_id?: string;
    result?: string;
    usage?: Record<string, number>;
    total_cost_usd?: number;
  };

  if (typed.type === "system" && typed.subtype === "init" && typed.session_id) {
    saveTaskSessionId(taskId, typed.session_id);
    log.debug({ taskId, agentName, sessionId: typed.session_id }, "Captured agent session ID");
    return;
  }

  if (typed.type !== "result") return;

  incrementTaskTokenUsage(taskId, {
    ...(typed.usage ?? {}),
    total_cost_usd: typed.total_cost_usd,
  });

  if (typed.subtype === "success") {
    setResultText(typed.result ?? "");
    log.info({ taskId, agentName }, "Subagent query completed successfully");
    return;
  }

  logActivity(taskId, "Agent", `${agentName} ended (${typed.subtype ?? "unknown"})`);
  log.warn({ taskId, subtype: typed.subtype }, "Subagent ended with non-success");
  throw new Error(`${agentName} failed: ${typed.subtype ?? "unknown"}`);
}

async function runQueryAttempt(
  options: SubagentQueryOptions,
  queryStartTimeoutMs: number,
  onStderr: (chunk: string) => void,
  setResultText: (value: string) => void,
): Promise<void> {
  const {
    taskId,
    projectRoot,
    agentName,
    prompt,
    maxBudgetUsd = null,
    agent,
    skipReview = false,
    extraSubagentStartHooks = [],
  } = options;

  const subagentStartHooks: Array<{ hooks: HookCallback[] }> = [
    { hooks: [createSubagentLogger(taskId)] },
  ];
  if (extraSubagentStartHooks.length > 0) {
    subagentStartHooks.push({ hooks: extraSubagentStartHooks });
  }

  const bypassPermissions = getEnv().AGENT_BYPASS_PERMISSIONS;
  const existingSessionId = getTaskSessionId(taskId);

  const stream = query({
    prompt,
    options: {
      cwd: projectRoot,
      env: {
        ...process.env,
        HANDOFF_MODE: "1",
        HANDOFF_TASK_ID: taskId,
        ...(skipReview ? { HANDOFF_SKIP_REVIEW: "1" } : {}),
      },
      pathToClaudeCodeExecutable: getClaudePath(),
      settingSources: ["project"],
      permissionMode: bypassPermissions ? "bypassPermissions" : "acceptEdits",
      ...(bypassPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: PROJECT_SCOPE_SYSTEM_APPEND,
      },
      ...(agent ? { extraArgs: { agent } } : {}),
      ...(maxBudgetUsd == null ? {} : { maxBudgetUsd }),
      ...(existingSessionId ? { resume: existingSessionId } : {}),
      ...modelOption(options.model ?? "sonnet"),
      stderr: onStderr,
      hooks: {
        PostToolUse: [{ hooks: [createActivityLogger(taskId)] }],
        SubagentStart: subagentStartHooks,
      },
    },
  });

  if (existingSessionId) {
    log.info(
      { taskId, agentName, sessionId: existingSessionId },
      "Resuming previous agent session",
    );
  }

  const iterator = stream[Symbol.asyncIterator]();
  const timeoutError = makeQueryStartTimeoutError(agentName, queryStartTimeoutMs);

  let firstEntry: IteratorResult<unknown>;
  try {
    firstEntry = await Promise.race<IteratorResult<unknown>>([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((_, reject) => {
        setTimeout(() => reject(timeoutError), queryStartTimeoutMs);
      }),
    ]);
  } catch (err) {
    try {
      await iterator.return?.();
    } catch {
      // best-effort stream cleanup
    }
    throw err;
  }

  if (!firstEntry.done) {
    processQueryMessage(firstEntry.value, taskId, agentName, setResultText);
  }

  // Continue consuming the remaining stream messages.
  for await (const message of stream) {
    processQueryMessage(message, taskId, agentName, setResultText);
  }
}

async function runWithRetry(
  options: SubagentQueryOptions,
  queryStartTimeoutMs: number,
  queryStartRetryDelayMs: number,
  onStderr: (chunk: string) => void,
  setResultText: (value: string) => void,
): Promise<void> {
  const { taskId, agentName } = options;

  try {
    await runQueryAttempt(options, queryStartTimeoutMs, onStderr, setResultText);
  } catch (err) {
    if (!isQueryStartTimeoutError(err)) throw err;

    log.warn(
      { taskId, agentName, attempt: 1, timeoutMs: queryStartTimeoutMs },
      "query_start_timeout detected, retrying subagent query once",
    );
    logActivity(taskId, "Agent", `${agentName} query_start_timeout on attempt 1; retrying once`);
    await sleep(queryStartRetryDelayMs);
    await runQueryAttempt(options, queryStartTimeoutMs, onStderr, setResultText);
  }
}

/**
 * Execute a Claude Agent SDK query with standardized:
 * - heartbeat timer
 * - stderr collection
 * - audit logging
 * - activity logging
 * - token usage tracking
 * - error diagnosis
 */
export async function executeSubagentQuery(
  options: SubagentQueryOptions,
): Promise<SubagentQueryResult> {
  const env = getEnv();
  const {
    taskId,
    projectRoot,
    agentName,
    prompt,
    maxBudgetUsd = null,
    queryStartTimeoutMs = env.AGENT_QUERY_START_TIMEOUT_MS,
    queryStartRetryDelayMs = env.AGENT_QUERY_START_RETRY_DELAY_MS,
  } = options;

  log.debug({ taskId, agentName, model: options.model }, "Executing subagent query");

  let resultText = "";
  const stderrCollector = createClaudeStderrCollector();

  const heartbeatTimer = startHeartbeat(taskId);
  logActivity(taskId, "Agent", `${agentName} started`);

  writeQueryAudit({
    timestamp: new Date().toISOString(),
    taskId,
    agentName,
    projectRoot,
    prompt,
    options: {
      model: options.model,
      settingSources: ["project"],
      maxBudgetUsd,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: PROJECT_SCOPE_SYSTEM_APPEND,
      },
    },
  });

  try {
    const applyResultText = (value: string) => {
      resultText = value;
    };

    await runWithRetry(
      options,
      queryStartTimeoutMs,
      queryStartRetryDelayMs,
      stderrCollector.onStderr,
      applyResultText,
    );

    logActivity(taskId, "Agent", `${agentName} complete`);
    return { resultText };
  } catch (err) {
    const reason = await diagnoseFailure(err, stderrCollector, projectRoot);
    logActivity(taskId, "Agent", `${agentName} failed — ${reason}`);
    log.error(
      { taskId, err, claudeStderr: stderrCollector.getTail() },
      `${agentName} execution failed`,
    );
    throw new Error(reason, { cause: err });
  } finally {
    try {
      clearInterval(heartbeatTimer);
    } catch {
      /* safety guard */
    }
  }
}

/** Start a periodic heartbeat that updates the task's lastHeartbeatAt. */
export function startHeartbeat(taskId: string): NodeJS.Timeout {
  return setInterval(() => {
    updateTaskHeartbeat(taskId);
  }, HEARTBEAT_INTERVAL_MS);
}

/** Diagnose a subagent failure using stderr and CLI probe. */
export async function diagnoseFailure(
  err: unknown,
  stderrCollector: ReturnType<typeof createClaudeStderrCollector>,
  projectRoot: string,
): Promise<string> {
  let detail = stderrCollector.getTail();
  if (!detail) {
    detail = await probeClaudeCliFailure(projectRoot, getClaudePath());
  }
  return explainClaudeFailure(err, detail);
}
