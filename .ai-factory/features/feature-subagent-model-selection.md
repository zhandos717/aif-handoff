# Feature: Per-Subagent Model Selection

## Summary

Add environment variables to configure which Claude model (haiku, sonnet, opus) each subagent and service uses, replacing hardcoded model references and enabling cost/performance tuning per role.

## Current State

- `modelOption(model)` helper in `packages/shared/src/env.ts` returns `{ model }` or `{}` depending on `ANTHROPIC_BASE_URL`
- `fastFix.ts` hardcodes `modelOption("haiku")`
- `roadmapGeneration.ts` hardcodes `modelOption("sonnet")` and `modelOption("haiku")`
- `implementer.ts` (checklist sync) hardcodes `modelOption("haiku")`
- `executeSubagentQuery()` in `subagentQuery.ts` does **not** pass model to the `query()` call — model is controlled by Claude Code CLI defaults
- 8 subagent/service roles need configurable models

## Target State

8 new optional env vars with sensible defaults, validated in `env.ts`, threaded through to all query call sites. When `ANTHROPIC_BASE_URL` is set, model is omitted (proxy decides).

## Tasks

### 1. Add env vars to `packages/shared/src/env.ts`

Add 8 optional string env vars to `envSchema`:

```ts
PLANNER_MODEL: z.string().optional(),
PLAN_CHECKER_MODEL: z.string().optional(),
IMPLEMENTER_MODEL: z.string().optional(),
REVIEWER_MODEL: z.string().optional(),
SECURITY_REVIEWER_MODEL: z.string().optional(),
FAST_FIX_MODEL: z.string().optional(),
ROADMAP_MODEL: z.string().optional(),
ROADMAP_EXTRACTION_MODEL: z.string().optional(),
```

Add a helper function `resolveModel(envModel: string | undefined, fallback: string)` that returns the env var value if set, otherwise the fallback. This keeps defaults centralized in env.ts.

Update `getEnv()` debug log to include resolved model config.

### 2. Update `.env.example`

Add a new section documenting all model env vars with defaults:

```env
# ----------------------------------------------------------
# Per-Subagent Model Selection
# ----------------------------------------------------------
# Override the Claude model used by each subagent/service.
# Values: haiku, sonnet, opus (or any model your provider supports).
# When ANTHROPIC_BASE_URL is set, these are ignored (proxy decides).

# Planning agents
# PLANNER_MODEL=sonnet
# PLAN_CHECKER_MODEL=haiku

# Implementation agent
# IMPLEMENTER_MODEL=sonnet

# Review sidecars
# REVIEWER_MODEL=sonnet
# SECURITY_REVIEWER_MODEL=sonnet

# API services
# FAST_FIX_MODEL=haiku
# ROADMAP_MODEL=sonnet        # roadmap file generation
# ROADMAP_EXTRACTION_MODEL=haiku  # roadmap→JSON extraction
```

### 3. Update `packages/agent/src/subagentQuery.ts`

Add an optional `model` field to `SubagentQueryOptions`:

```ts
export interface SubagentQueryOptions {
  // ... existing fields ...
  /** Claude model to use. Falls back to Claude Code default when unset. */
  model?: string;
}
```

Pass it through to the `query()` call via `modelOption()`:

```ts
const env = getEnv();
// ...
const stream = query({
  prompt,
  options: {
    // ... existing options ...
    ...modelOption(options.model ?? "sonnet"),
    // ...
  },
});
```

Log the selected model at DEBUG level in `executeSubagentQuery`.

### 4. Update subagent callers to pass model from env

**`packages/agent/src/subagents/planner.ts`**:
- Import `getEnv` and `resolveModel` from `@aif/shared`
- Pass `model: resolveModel(env.PLANNER_MODEL, "sonnet")` to `executeSubagentQuery`

**`packages/agent/src/subagents/planChecker.ts`**:
- Import `getEnv` and `resolveModel` from `@aif/shared`
- Pass `model: resolveModel(env.PLAN_CHECKER_MODEL, "haiku")` to `executeSubagentQuery`

**`packages/agent/src/subagents/implementer.ts`**:
- Import `getEnv` and `resolveModel` from `@aif/shared`
- Pass `model: resolveModel(env.IMPLEMENTER_MODEL, "sonnet")` to `executeSubagentQuery`
- Replace `modelOption("haiku")` in `runChecklistSyncQuery` with `modelOption(resolveModel(env.FAST_FIX_MODEL, "haiku"))`

**`packages/agent/src/subagents/reviewer.ts`**:
- Import `getEnv` and `resolveModel` from `@aif/shared`
- Pass `model: resolveModel(env.REVIEWER_MODEL, "sonnet")` for review sidecar
- Pass `model: resolveModel(env.SECURITY_REVIEWER_MODEL, "sonnet")` for security sidecar
- Update `runSidecar` to accept and forward model parameter

### 5. Update `packages/api/src/services/fastFix.ts`

Replace `modelOption("haiku")` with `modelOption(resolveModel(env.FAST_FIX_MODEL, "haiku"))`.

Import `getEnv` and `resolveModel` from `@aif/shared`.

### 6. Update `packages/api/src/services/roadmapGeneration.ts`

Replace two hardcoded model references:
- `generateRoadmapFile`: `modelOption("sonnet")` → `modelOption(resolveModel(env.ROADMAP_MODEL, "sonnet"))`
- `generateRoadmapTasks`: `modelOption("haiku")` → `modelOption(resolveModel(env.ROADMAP_EXTRACTION_MODEL, "haiku"))`

Import `getEnv` and `resolveModel` from `@aif/shared`.

### 7. Export `resolveModel` from `packages/shared/src/index.ts`

Add `resolveModel` to the shared package exports so all consumers can import it.

### 8. Write tests

**`packages/shared/src/__tests__/env.test.ts`** — add test cases:
- `resolveModel` returns env value when set
- `resolveModel` returns fallback when env value is undefined
- `resolveModel` returns fallback when env value is empty string
- `modelOption` still respects `ANTHROPIC_BASE_URL` override with new env vars
- Env validation accepts all new optional model vars
- Env validation applies undefined (no default) for model vars

**`packages/agent/src/__tests__/subagentQuery.test.ts`** — add test cases:
- `executeSubagentQuery` passes model option to query when provided
- `executeSubagentQuery` omits model option when model is undefined
- Verify model appears in debug log output

**`packages/api/src/__tests__/fastFix.test.ts`** — add test case:
- Verify query is called with configured model from env (mock `getEnv`)

**`packages/api/src/__tests__/roadmapGeneration.test.ts`** — add test cases:
- Verify `generateRoadmapFile` uses configured model
- Verify `generateRoadmapTasks` uses configured extraction model

## File Change Summary

| File | Change |
|------|--------|
| `packages/shared/src/env.ts` | Add 8 env vars + `resolveModel()` helper |
| `packages/shared/src/index.ts` | Export `resolveModel` |
| `.env.example` | Document all model env vars |
| `packages/agent/src/subagentQuery.ts` | Add `model` option, pass to query |
| `packages/agent/src/subagents/planner.ts` | Pass planner model from env |
| `packages/agent/src/subagents/planChecker.ts` | Pass plan checker model from env |
| `packages/agent/src/subagents/implementer.ts` | Pass implementer + fast fix models from env |
| `packages/agent/src/subagents/reviewer.ts` | Pass reviewer + security reviewer models from env |
| `packages/api/src/services/fastFix.ts` | Use env-based fast fix model |
| `packages/api/src/services/roadmapGeneration.ts` | Use env-based roadmap models |
| `packages/shared/src/__tests__/env.test.ts` | Tests for `resolveModel` + new env vars |
| `packages/agent/src/__tests__/subagentQuery.test.ts` | Tests for model passing |
| `packages/api/src/__tests__/fastFix.test.ts` | Test for model config |
| `packages/api/src/__tests__/roadmapGeneration.test.ts` | Tests for roadmap model config |

## Model Defaults Rationale

| Role | Default | Rationale |
|------|---------|-----------|
| PLANNER_MODEL | sonnet | Planning requires reasoning depth |
| PLAN_CHECKER_MODEL | haiku | Simple checklist validation |
| IMPLEMENTER_MODEL | sonnet | Main coding work |
| REVIEWER_MODEL | sonnet | Code review needs analysis |
| SECURITY_REVIEWER_MODEL | sonnet | Security audit needs analysis |
| FAST_FIX_MODEL | haiku | Quick plan edits, cheap |
| ROADMAP_MODEL | sonnet | Strategic milestone generation |
| ROADMAP_EXTRACTION_MODEL | haiku | Simple JSON extraction |
