import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const incrementTaskTokenUsage = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => mockQuery(args),
}));

vi.mock("@aif/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aif/data")>();
  return {
    ...actual,
    incrementTaskTokenUsage,
  };
});

const { runFastFixQuery, withTimeout } = await import("../services/fastFix.js");

function successResult(result: string) {
  return async function* () {
    yield {
      type: "result",
      subtype: "success",
      result,
      usage: {},
      total_cost_usd: 0,
    };
  };
}

describe("fastFix service", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    incrementTaskTokenUsage.mockReset();
  });

  it("returns plan text on success and records usage", async () => {
    mockQuery.mockImplementation(successResult("## Plan\n- Updated"));

    const updated = await runFastFixQuery({
      taskId: "task-1",
      taskTitle: "Task",
      taskDescription: "Desc",
      latestComment: {
        author: "human",
        message: "Please update",
        attachments: "[]",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Old plan",
    });

    expect(updated).toBe("## Plan\n- Updated");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(incrementTaskTokenUsage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ total_cost_usd: 0 }),
    );
  });

  it("uses fallback prompt mode when file update is disabled", async () => {
    mockQuery.mockImplementation(successResult("## Full updated plan"));

    await runFastFixQuery({
      taskId: "task-2",
      taskTitle: "Task 2",
      taskDescription: "Desc 2",
      latestComment: {
        author: "human",
        message: "Fix quickly",
        attachments: "[]",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Previous",
      priorAttempt: "too short",
      shouldTryFileUpdate: false,
    });

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      prompt: string;
      options: { systemPrompt?: { append?: string } };
    };
    expect(callArg.prompt).toContain("PRIOR_ATTEMPT");
    expect(callArg.prompt).toContain("Do not use tools/subagents");
    expect(callArg.prompt).toContain("PLAN PATH");
    expect(callArg.prompt).toContain("@.ai-factory/PLAN.md");
    expect(callArg.options.systemPrompt?.append).toContain("Do not use tools");
  });

  it("builds prior-attempt prompt with file-update instructions and attachment previews", async () => {
    mockQuery.mockImplementation(successResult("## Updated plan with file write"));

    await runFastFixQuery({
      taskId: "task-2b",
      taskTitle: "Task 2b",
      taskDescription: "Desc 2b",
      latestComment: {
        author: "human",
        message: "Use attached snippet",
        attachments: JSON.stringify([
          {
            name: "snippet.txt",
            mimeType: "text/plain",
            size: 12,
            content: "line-1\nline-2",
          },
        ]),
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Previous",
      priorAttempt: "still too short",
      shouldTryFileUpdate: true,
    });

    const callArg = mockQuery.mock.calls[0]?.[0] as {
      prompt: string;
      options: { systemPrompt?: { append?: string } };
    };
    expect(callArg.prompt).toContain("PRIOR_ATTEMPT");
    expect(callArg.prompt).toContain("Also update the plan file @.ai-factory/PLAN.md");
    expect(callArg.prompt).toContain("line-1");
    expect(callArg.options.systemPrompt?.append).toBeUndefined();
  });

  it("marks attachment content as missing when neither inline content nor path is present", async () => {
    mockQuery.mockImplementation(successResult("## Updated plan"));

    await runFastFixQuery({
      taskId: "task-2c",
      taskTitle: "Task 2c",
      taskDescription: "Desc 2c",
      latestComment: {
        author: "human",
        message: "Apply from metadata",
        attachments: JSON.stringify([
          {
            name: "context.json",
            mimeType: "application/json",
            size: 100,
            content: null,
          },
        ]),
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Previous",
    });

    const callArg = mockQuery.mock.calls[0]?.[0] as { prompt: string };
    expect(callArg.prompt).toContain("content: [not provided]");
  });

  it("throws when model returns non-success subtype", async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "error_max_turns",
        result: "",
        usage: {},
        total_cost_usd: 0,
      };
    });

    await expect(
      runFastFixQuery({
        taskId: "task-3",
        taskTitle: "Task 3",
        taskDescription: "Desc 3",
        latestComment: {
          author: "human",
          message: "Comment",
          attachments: "[]",
          createdAt: "2026-03-28T00:00:00.000Z",
        },
        projectRoot: process.cwd(),
        planPath: ".ai-factory/PLAN.md",
        previousPlan: "## Previous",
      }),
    ).rejects.toThrow("Fast fix failed");
  });

  it("throws when model returns empty plan text", async () => {
    mockQuery.mockImplementation(successResult("   "));

    await expect(
      runFastFixQuery({
        taskId: "task-4",
        taskTitle: "Task 4",
        taskDescription: "Desc 4",
        latestComment: {
          author: "human",
          message: "Comment",
          attachments: "[]",
          createdAt: "2026-03-28T00:00:00.000Z",
        },
        projectRoot: process.cwd(),
        planPath: ".ai-factory/PLAN.md",
        previousPlan: "## Previous",
      }),
    ).rejects.toThrow("did not return updated plan text");
  });

  it("resolves and rejects through withTimeout helper", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "timeout")).resolves.toBe("ok");
    await expect(
      withTimeout(
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("late"), 50);
        }),
        1,
        "timed out",
      ),
    ).rejects.toThrow("timed out");
  });

  it("uses configured FAST_FIX_MODEL from env when set", async () => {
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;

    mockQuery.mockImplementation(successResult("## Plan with custom model"));

    await runFastFixQuery({
      taskId: "task-model",
      taskTitle: "Task",
      taskDescription: "Desc",
      latestComment: {
        author: "human",
        message: "Update model",
        attachments: "[]",
        createdAt: "2026-03-28T00:00:00.000Z",
      },
      projectRoot: process.cwd(),
      planPath: ".ai-factory/PLAN.md",
      previousPlan: "## Old plan",
    });

    const callOptions = mockQuery.mock.calls[0][0].options;
    expect(callOptions).toHaveProperty("model");

    if (originalBaseUrl) {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    }
  });
});
