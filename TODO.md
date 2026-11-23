# TODO

## Milestone 1: Communication foundation — DONE

- [x] Agent roles & capabilities (`AgentRole`, `AgentCapability`) on `Agent` type
- [x] MongoDB collection types: agentTasks, agentMessages, sharedContexts, executionEvents, agentEvaluations, approvalRequests
- [x] Lazy index creation (`src/lib/mongo/indices.ts`)
- [x] Dev endpoint extended to create new collections
- [x] API persistence: `/api/runs/[[...path]]` (runs, tasks, messages, evaluations, approvals, events)
- [x] Agent capabilities CRUD (`/api/agents/:id/capabilities`)
- [x] Index migration notes (`doc/MULTI_AGENT_DB_INDEXES.md`)

## Milestone 2: Sequential multi-agent execution — DONE

- [x] Orchestration types, dependency resolver, context manager, message bus, task manager
- [x] Orchestrator engine — sequential execution via `executeTaskBodyWithId` (named `executeTaskBody` in the plan; the function was renamed)
- [x] API endpoint `POST /api/orchestrate` — { agentId, input, mode? }

## Milestone 3: Parallel execution — DONE

- [x] Task scheduler — bounded concurrency, dependency-aware, run-level timeout
- [x] Parallel execution path in orchestrator
- [x] `POST /api/orchestrate` supports `mode: 'parallel'`

## Milestone 4: Supervisor orchestration — DONE

- [x] Supervisor plan types, agent discovery, plan generation, validation, execution
- [x] Supervisor mode integrated into orchestrator (`mode: 'supervisor'`)
- [x] API endpoint `POST /api/supervisor/plan` — generate + validate plan (preview/approval)

## Milestone 5: Evaluation and recovery — DONE

- [x] Critic/fact-checker evaluation (accuracy, relevance, completeness, groundedness)
- [x] Critic agent discovery (role: 'critic' or 'fact_checker')
- [x] Evaluation integrated into sequential mode with revision on failure
- [ ] Max review cycles (3) to prevent infinite debates — NOT DONE on this copy: `reviewCycle` is hardcoded to 0 in the orchestrator, so at most one revision runs. Fix pending (Lane A, P1-3).
- [x] Retry/fallback recovery (decideRecovery, retryTaskWithFeedback)
- [x] RetryPolicy (maxRetries, backoffMs, retryableErrors, fallbackAgentId, fallbackModel)

## Milestone 6: Human approval and monitoring — DONE

- [x] Approval manager — create, approve, reject, edit approval requests
- [ ] Approval checkpoints in orchestrator — pauses run when agent requires human approval — NOT DONE on a first run: the checkpoint needs a pre-existing task id, so it is skipped until a task already exists. Fix pending (Lane A, P0-6).
- [ ] Resume after approval — skips already-completed tasks — NOT DONE: resume only flips a status string and never re-executes. Pinned by `tests/phase3/cases/approvals.cjs`. Fix pending (Lane A, P0-6).
- [ ] API endpoints: POST /api/approvals/:id/approve, /reject, /edit — NOT DONE: the handler only accepts a 1-segment path, so every 2-segment call 404s. Fix pending (Lane A, P0-6).
- [x] API endpoint: GET /api/approvals (list pending, filter by runId)
- [x] Live execution timeline: GET /api/runs/:runId/events
- [x] Workflow pause/resume status tracking

## Milestone 7: Production hardening — DONE

- [x] Audit logging utility (`src/lib/audit.ts`) — fire-and-forget audit events
- [x] Permission checks (`src/lib/permissions.ts`) — ownership, permissions, rate limits, budgets
- [x] Execution budgets per user (maxRunsPerHour, maxRunDurationMs, maxTasksPerRun, maxMessagesPerRun)
- [x] User settings extended with permissions + executionBudget fields
- [x] Zod validation schemas (`src/lib/validation/orchestrationSchemas.ts`)
- [x] `POST /api/orchestrate` enforces permissions, ownership, budgets, audit logging
- [x] Production build passes (`next build`)

## Implementation status (updated 2026-11-17, Lane D, Phase 3)

Milestones 1–4 and 7 are implemented except for the items unchecked above.
Milestone 5 is implemented except the review-cycle limit. Milestone 6 is
implemented except the approval endpoints, the first-run checkpoint, and
resume. The "Definition of Done" item "Unit, integration, and end-to-end
tests pass" is not met on the base copy: the Phase 3 contract suite
(`npm run test:phase3`, 32 cases) passes 12 and fails 20, each failing
case naming the lane fix it waits on. The repository is at:
https://github.com/SP23-BSE-106/FYPAGENTFLOW.git (branch: main)
