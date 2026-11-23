/**
 * Supervisor agent and dynamic delegation (implementation plan Phase 8).
 *
 * A supervisor analyses a natural-language request, breaks it into subtasks,
 * selects agents by capability, and produces a structured execution plan.
 * The plan is validated before execution, then run through the bounded
 * concurrency scheduler.
 *
 * Modules it composes:
 *   - taskManager         — task lifecycle
 *   - messageBus          — structured agent-to-agent messages
 *   - contextManager      — shared run context
 *   - scheduler           — bounded-concurrency execution
 */

import { chatCompletion } from '@/lib/llm'
import { getDb } from '@/lib/mongo/mongo'

import { createTask } from './taskManager'
import { getSharedContext, updateSharedContext } from './contextManager'
import { scheduleParallel, type SchedulerConfig } from './scheduler'
import { topologicalSort } from './dependencyResolver'
import type { NodeExecutionResult } from './types'
import type { Agent } from '@/lib/mongo/agent'
import { supervisorPlanSchema } from '@/lib/validation/orchestrationSchemas'

/** Max number of tasks a supervisor plan may contain. */
const MAX_SUPERVISOR_TASKS = 10

/** Default scheduler config for supervisor-driven runs. */
const SUPERVISOR_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentTasks: 5,
  maxRunDurationMs: 300_000, // 5 minutes
  maxMessagesPerRun: 500,
}

/* ─────────────── conversational supervisor (lane D) ─────────────── */

/**
 * Hard cap on conversational exchanges per run. One exchange is one
 * supervisor question plus its answer; an agent asking back plus the
 * supervisor's reply counts as one further exchange. The cap is never
 * infinite: when it is hit the run ends honestly with the work so far.
 */
export const MAX_CONVERSATION_EXCHANGES = 10

/** Default per-run time budget for conversational rounds (same 5 minutes as the supervisor scheduler). */
export const DEFAULT_CONVERSATION_TIME_BUDGET_MS = 300_000

/** How a conversational supervisor run ended. */
export type ConversationEndReason = 'final' | 'turn_cap' | 'time_budget' | 'cancelled'

/** Summary of a conversational supervisor run (returned and persisted to shared context). */
export type SupervisorConversationSummary = {
  exchanges: number
  /** Supervisor decision turns taken. */
  rounds: number
  questionsAsked: number
  planRevisions: number
  droppedTaskIds: string[]
  endedBecause: ConversationEndReason
  /** temporaryIds still pending when the conversation ended (empty on a clean finish). */
  pendingTaskIds: string[]
}

/** Options for conversational supervision. */
export type SupervisorConversationOptions = {
  /**
   * When true the supervisor holds conversational rounds (ask agents,
   * re-plan from answers) before deciding the job is done. Default false:
   * the old fixed-plan path runs exactly as before.
   */
  conversational?: boolean
  /** Hard turn cap override (default MAX_CONVERSATION_EXCHANGES). */
  maxExchanges?: number
  /** Per-run time budget override in ms (default DEFAULT_CONVERSATION_TIME_BUDGET_MS). */
  timeBudgetMs?: number
}

/**
 * One agent turn in the FROZEN TURN FORMAT (shared with all multi-agent
 * lanes): an agent's LLM output is either a final answer or a message to
 * a teammate. Unparsable output is treated as a final answer.
 */
export type SupervisorTurn =
  | { kind: 'final'; text: string }
  | { kind: 'message'; to: string; text: string; requiresResponse: boolean }

/** Supervisor-side id used as fromAgentId for supervisor messages (the supervisor has no agent row; 'system' is reserved for system notes). */
export const SUPERVISOR_SENDER_ID = 'supervisor'

/* ───────────────────────── plan types ───────────────────────── */

/** One task in a supervisor-generated execution plan. */
export type SupervisorPlanTask = {
  /** Client-side id used to wire dependencies before real task ids exist. */
  temporaryId: string
  /** id of the agent that should perform this task. */
  agentId: string
  /** Human-readable description of the work. */
  description: string
  /** temporaryIds of tasks this task depends on. */
  dependsOn: string[]
  /** Description of the expected output. */
  expectedOutput: string
}

/** A supervisor-generated execution plan. */
export type SupervisorPlan = {
  objective: string
  tasks: SupervisorPlanTask[]
  completionCriteria: string[]
}

/** Result of validating a plan against the available agents. */
export type PlanValidation = {
  valid: boolean
  errors: string[]
}

/** Summary of an agent, shown in a plan preview. */
export type AgentSummary = {
  id: string
  name: string
  role?: string
  capabilities: string[]
}

/* ─────────────────────── agent discovery ────────────────────── */

/** List the caller's agents with their capabilities for plan selection. */
export async function listAvailableAgents(
  userId: string,
): Promise<AgentSummary[]> {
  const db = await getDb()
  const agents = await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0 } })
    .sort({ createdAt: -1 })
    .toArray()

  return (agents as unknown as Agent[]).map((agent) => ({
    id: String(agent._id),
    name: agent.name,
    role: agent.role,
    capabilities: (agent.capabilities || []).map((cap) => cap.name),
  }))
}

/* ─────────────────────── plan generation ────────────────────── */

/**
 * Ask the supervisor agent (or the default inference provider) to break the
 * user's request into a structured execution plan.
 *
 * The LLM is instructed to return JSON matching the SupervisorPlan schema.
 * Agent selection is capability-based: the plan may only reference agents
 * that exist in the caller's workspace.
 *
 * `options.conversational` is accepted for API symmetry with
 * executeSupervisorPlan; plan generation itself is a single LLM call and
 * the plan shape is identical either way — the flag is consumed by
 * execution, where the supervisor asks agents questions and re-plans.
 */
export async function generateSupervisorPlan(
  userId: string,
  input: string,
  agents: AgentSummary[],
  options?: { conversational?: boolean },
): Promise<SupervisorPlan> {
  void options?.conversational
  // Build a capability catalogue for the LLM to choose from.
  const capabilityCatalogue = agents
    .map(
      (a) =>
        `- ${a.name} (${a.id}) [role: ${a.role || 'general'}]${
          a.capabilities.length
            ? ` capabilities: ${a.capabilities.join(', ')}`
            : ''
        }`,
    )
    .join('\n') ||
    'No agents configured. Create agents first.'

  const system = `You are a supervisor agent in the AgentFlow multi-agent platform.

Your job is to break a user's request into a structured execution plan.
You must return ONLY valid JSON matching this schema:

{
  "objective": "string - restated goal of the whole request",
  "tasks": [
    {
      "temporaryId": "string - unique id like 't1', 't2', ...",
      "agentId": "string - id of an agent from the list below",
      "description": "string - what this agent should do",
      "dependsOn": ["string"] - temporaryIds of tasks this depends on,
      "expectedOutput": "string - what success looks like"
    }
  ],
  "completionCriteria": ["string"] - how to know the whole request is done
}

Rules:
- Pick agents from the capability catalogue below by matching their
  capabilities to each task.
- temporaryId values must be unique (t1, t2, t3...).
- dependsOn must only reference temporaryIds of earlier tasks (no cycles).
- Keep the task count at or below ${MAX_SUPERVISOR_TASKS}.
- Do not invent agent ids — use only ids from the catalogue.
- Return valid JSON only, no markdown fences, no extra text.

Available agents:
${capabilityCatalogue}`

  const completion = await chatCompletion({
    system,
    prompt: `User request: ${input}\n\nGenerate the execution plan as JSON.`,
    maxTokens: 2048,
    temperature: 0.3,
    timeoutMs: 30_000,
  })

  if (!completion.ok) {
    const failures = completion.failures
      ?.map((f) => `${f.provider}: ${f.message}`)
      .join('; ')
    throw new Error(
      `Supervisor could not generate a plan: ${failures || 'no provider answered'}`,
    )
  }

  const plan = parseSupervisorPlan(completion.text)
  return plan
}

/** Parse and lightly normalize a supervisor plan from LLM output text. */
function parseSupervisorPlan(text: string): SupervisorPlan {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Try to extract a JSON block from fenced output.
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      throw new Error('Supervisor response was not valid JSON.')
    }
    try {
      raw = JSON.parse(match[0])
    } catch {
      throw new Error('Supervisor response was not valid JSON.')
    }
  }

  const parsed = supervisorPlanSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Supervisor plan validation failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    )
  }
  return parsed.data
}

/* ─────────────────────── plan validation ────────────────────── */

/**
 * Validate a supervisor plan against the available agents.
 *
 * Checks:
 *   - every referenced agentId exists and belongs to the caller
 *   - every dependsOn references a known temporaryId
 *   - no dependency cycles
 *   - task count within limits
 */
export function validateSupervisorPlan(
  plan: SupervisorPlan,
  agents: AgentSummary[],
): PlanValidation {
  const errors: string[] = []
  const agentIds = new Set(agents.map((a) => a.id))
  const temporaryIds = new Set(plan.tasks.map((t) => t.temporaryId))

  // Task count limit.
  if (plan.tasks.length === 0) {
    errors.push('Plan must contain at least one task.')
  }
  if (plan.tasks.length > MAX_SUPERVISOR_TASKS) {
    errors.push(
      `Plan exceeds maximum of ${MAX_SUPERVISOR_TASKS} tasks (${plan.tasks.length} requested).`,
    )
  }

  // Unique temporaryIds.
  const seenIds = new Set<string>()
  for (const task of plan.tasks) {
    if (seenIds.has(task.temporaryId)) {
      errors.push(`Duplicate temporaryId "${task.temporaryId}".`)
    }
    seenIds.add(task.temporaryId)

    // Agent exists.
    if (!task.agentId || !agentIds.has(task.agentId)) {
      errors.push(
        `Task "${task.temporaryId}" references unknown agent "${task.agentId}".`,
      )
    }

    // Dependencies reference known tasks.
    for (const dep of task.dependsOn) {
      if (!temporaryIds.has(dep)) {
        errors.push(
          `Task "${task.temporaryId}" depends on unknown task "${dep}".`,
        )
      }
      // No self-dependency.
      if (dep === task.temporaryId) {
        errors.push(`Task "${task.temporaryId}" depends on itself.`)
      }
    }
  }

  // Cycle detection over the temporary-id graph.
  if (hasPlanCycle(plan.tasks)) {
    errors.push('Plan contains a dependency cycle.')
  }

  return { valid: errors.length === 0, errors }
}

/** Detect cycles in the plan's dependency graph (DFS). */
function hasPlanCycle(tasks: SupervisorPlanTask[]): boolean {
  const byId = new Map(tasks.map((t) => [t.temporaryId, t]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const dfs = (id: string): boolean => {
    if (visited.has(id)) return false
    if (visiting.has(id)) return true // back edge = cycle
    const task = byId.get(id)
    if (!task) return false
    visiting.add(id)
    for (const dep of task.dependsOn) {
      if (dfs(dep)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const task of tasks) {
    if (dfs(task.temporaryId)) return true
  }
  return false
}

/* ────────────────── frozen turn format (lane D) ────────────────── */

/**
 * Parse one agent turn from LLM output text, in the FROZEN TURN FORMAT
 * shared with all multi-agent lanes:
 *   {"kind":"final","text":"..."} — the agent's answer, turn over.
 *   {"kind":"message","to":"<agent id | role | name>","text":"...","requiresResponse":true|false}
 *     — a message to a teammate.
 * Unparsable output is treated as a final answer carrying the raw text.
 */
export function parseSupervisorTurn(text: string): SupervisorTurn {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const candidates = [cleaned]
  const block = cleaned.match(/\{[\s\S]*\}/)
  if (block && block[0] !== cleaned) candidates.push(block[0])
  for (const candidate of candidates) {
    try {
      const raw: unknown = JSON.parse(candidate)
      if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>
        if (obj.kind === 'final' && typeof obj.text === 'string') {
          return { kind: 'final', text: obj.text }
        }
        if (
          obj.kind === 'message' &&
          typeof obj.to === 'string' &&
          obj.to.trim() &&
          typeof obj.text === 'string'
        ) {
          return {
            kind: 'message',
            to: obj.to,
            text: obj.text,
            requiresResponse: obj.requiresResponse === true,
          }
        }
      }
    } catch {
      // Try the next candidate; unparsable output falls through to final.
    }
  }
  return { kind: 'final', text }
}

/**
 * Resolve a turn's `to` address (agent id, role, or name) to an agent the
 * user owns. Id wins, then role, then name (all case-insensitive).
 * Throws an honest error when nothing matches — a message is never sent
 * to an agent the user does not own.
 */
export function resolveTurnRecipient(
  to: string,
  agents: AgentSummary[],
): AgentSummary {
  const needle = to.trim().toLowerCase()
  if (!needle) {
    throw new Error('Supervisor question has no recipient.')
  }
  const byId = agents.find((a) => a.id.toLowerCase() === needle)
  if (byId) return byId
  const byRole = agents.find((a) => (a.role || '').toLowerCase() === needle)
  if (byRole) return byRole
  const byName = agents.find((a) => a.name.toLowerCase() === needle)
  if (byName) return byName
  throw new Error(
    `Supervisor question addressed unknown agent "${to}" — no agent with that id, role, or name.`,
  )
}

/**
 * Validate a supervisor re-plan against the run's history.
 *
 * On top of the base plan validation (agents exist, dependencies known,
 * no cycles, task count), a re-plan must also obey:
 *   - it can never resurrect a task dropped earlier in the same run
 *     (recorded in `droppedTaskIds`);
 *   - it can never drop or modify a task that already executed.
 *
 * Returns the tasks the re-plan newly drops (pending tasks only), so the
 * caller can record them. A failed validation ends the run honestly —
 * the caller must never run a broken plan.
 */
export function validateReplan(args: {
  previousPlan: SupervisorPlan
  revisedPlan: SupervisorPlan
  droppedTaskIds: ReadonlySet<string> | string[]
  executedTaskIds: ReadonlySet<string> | string[]
  agents: AgentSummary[]
}): { valid: boolean; errors: string[]; newlyDropped: string[] } {
  const errors: string[] = []
  const dropped = new Set(args.droppedTaskIds)
  const executed = new Set(args.executedTaskIds)

  const base = validateSupervisorPlan(args.revisedPlan, args.agents)
  errors.push(...base.errors)

  const prevById = new Map(
    args.previousPlan.tasks.map((t) => [t.temporaryId, t]),
  )
  const revisedById = new Map(
    args.revisedPlan.tasks.map((t) => [t.temporaryId, t]),
  )

  // A re-plan can never resurrect a task dropped earlier in the same run.
  for (const id of revisedById.keys()) {
    if (dropped.has(id)) {
      errors.push(`Re-plan resurrects dropped task "${id}".`)
    }
  }

  // Already-executed tasks must be preserved verbatim, never dropped.
  for (const id of executed) {
    const revised = revisedById.get(id)
    if (!revised) {
      errors.push(`Re-plan drops already-executed task "${id}".`)
      continue
    }
    const prev = prevById.get(id)
    if (
      prev &&
      (revised.agentId !== prev.agentId ||
        revised.description !== prev.description ||
        revised.expectedOutput !== prev.expectedOutput ||
        JSON.stringify([...revised.dependsOn].sort()) !==
          JSON.stringify([...prev.dependsOn].sort()))
    ) {
      errors.push(`Re-plan modifies already-executed task "${id}".`)
    }
  }

  const newlyDropped = [...prevById.keys()].filter(
    (id) => !revisedById.has(id) && !executed.has(id),
  )

  return { valid: errors.length === 0, errors, newlyDropped }
}

/* ─────────────────────── plan execution ─────────────────────── */

/**
 * Execute a validated supervisor plan.
 *
 * Creates tasks in dependency order, wires dependsOnTaskIds, then runs them
 * through the bounded-concurrency scheduler. Returns the orchestration
 * result shape.
 */
export async function executeSupervisorPlan(
  userId: string,
  workflowRunId: string,
  plan: SupervisorPlan,
  agents: Agent[],
  options?: {
    /** Original user request — passed into every task's prompt. */
    originalInput?: string
    getMessageCount?: () => Promise<number>
    isCancelled?: () => Promise<boolean>
    /**
     * When true the supervisor holds conversational rounds (ask agents,
     * re-plan from answers) before deciding the job is done. Default
     * false: the old fixed-plan path runs exactly as before.
     */
    conversational?: boolean
    /** Hard turn cap override (default MAX_CONVERSATION_EXCHANGES). */
    maxExchanges?: number
    /** Per-run time budget override in ms (default DEFAULT_CONVERSATION_TIME_BUDGET_MS). */
    timeBudgetMs?: number
  },
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
  /** Present only on conversational runs. */
  conversation?: SupervisorConversationSummary
}> {
  // Conversational supervision is a separate execution path. The fixed-plan
  // body below is untouched, so conversational=false behaves exactly as
  // before — same plan shape, same task order, no conversation messages.
  if (options?.conversational) {
    return executeConversationalSupervisorPlan(
      userId,
      workflowRunId,
      plan,
      agents,
      options,
    )
  }

  const agentById = new Map(agents.map((a) => [String(a._id), a]))
  const taskIdByTempId = new Map<string, string>()

  // ── Order tasks topologically ────────────────────────────────────────
  // The old pairwise comparator was not a topological sort: for chains of
  // 3+ tasks it could place a dependent before its dependency. Kahn's
  // algorithm over temporaryId/dependsOn, same as the graph orchestrator.
  const planNodes = plan.tasks.map((t) => ({
    id: t.temporaryId,
    name: t.description.slice(0, 80),
    type: 'llm' as const,
    description: t.description,
  }))
  const planEdges = plan.tasks.flatMap((t) =>
    t.dependsOn.map((dep) => ({ id: `${dep}->${t.temporaryId}`, source: dep, target: t.temporaryId })),
  )
  let orderedIds: string[]
  try {
    orderedIds = topologicalSort(planNodes, planEdges)
  } catch (error) {
    throw new Error(`Supervisor plan has a dependency cycle or an unresolvable dependency: ${error instanceof Error ? error.message : String(error)}`)
  }
  const ordered = orderedIds.map((id) => plan.tasks.find((t) => t.temporaryId === id)!)

  for (const task of ordered) {
    const agent = agentById.get(task.agentId) ?? null
    const dependsOnTaskIds: string[] = []
    for (const depTempId of task.dependsOn) {
      const depTaskId = taskIdByTempId.get(depTempId)
      if (!depTaskId) {
        throw new Error(`Supervisor plan task "${task.temporaryId}" depends on "${depTempId}", which was not created. The plan is invalid; refusing to run a dependent without its dependency.`)
      }
      dependsOnTaskIds.push(depTaskId)
    }

    const created = await createTask({
      userId,
      workflowRunId,
      agentId: agent?._id ?? 'system',
      title: task.description.slice(0, 120),
      description: task.description,
      input: {},
      dependsOnTaskIds,
      maxRetries: 3,
    })

    taskIdByTempId.set(task.temporaryId, String(created._id))
  }

  // ── Build schedulable tasks ────────────────────────────────────────
  const schedulableTasks = plan.tasks.map((task) => {
    const taskId = taskIdByTempId.get(task.temporaryId)!
    const agent = agentById.get(task.agentId) ?? null

    return {
      id: taskId,
      dependsOnTaskIds: task.dependsOn
        .map((d) => taskIdByTempId.get(d))
        .filter((id): id is string => Boolean(id)),
      execute: async () => {
        // Build a minimal node-like descriptor for execution.
        const node = {
          id: task.temporaryId,
          name: task.description.slice(0, 80),
          type: 'supervisor_task' as const,
          description: task.description,
          config: {},
        }

        // Re-read shared context at execution time so a dependent task sees
        // the outputs of the tasks it depends on — not an empty snapshot.
        const shared = await getSharedContext(userId, workflowRunId)
        const previousResults: Record<string, unknown> = {
          ...(shared.intermediateResults ?? {}),
        }

        return runSupervisorNode(
          taskId,
          userId,
          workflowRunId,
          { node, agent },
          task.expectedOutput,
          options?.originalInput ?? '',
          previousResults,
        )
      },
    }
  })

  // ── Run via bounded-concurrency scheduler ──────────────────────────
  // Supervisor runs get the same guards as parallel runs: message cap and
  // cancellation, which they previously escaped.
  const schedule = await scheduleParallel(
    schedulableTasks,
    {
      ...SUPERVISOR_SCHEDULER_CONFIG,
      getMessageCount: options?.getMessageCount,
      isCancelled: options?.isCancelled,
    },
  )

  // ── Collect results ────────────────────────────────────────────────
  let messagesCreated = 0
  let finalOutput: unknown = null

  for (const task of plan.tasks) {
    const taskId = taskIdByTempId.get(task.temporaryId)!
    const result = schedule.results.get(taskId)
    if (!result) continue

    messagesCreated += result.messages?.length ?? 0

    if (result.ok) {
      finalOutput = {
        ...(typeof finalOutput === 'object' && finalOutput !== null
          ? finalOutput
          : {}),
        [task.temporaryId]: result.output,
      }
    } else {
      finalOutput = {
        ...(typeof finalOutput === 'object' && finalOutput !== null
          ? finalOutput
          : {}),
        [task.temporaryId]: { error: result.error },
      }
    }
  }

  return {
    completed: schedule.completed,
    failed: schedule.failed + schedule.cancelled.length,
    messagesCreated,
    finalOutput,
  }
}

/* ─────────────── conversational execution (lane D) ─────────────── */

/** Mutable counters shared by the conversational round helpers. */
type ConversationCounters = {
  exchanges: number
  questionsAsked: number
  planRevisions: number
  messagesCreated: number
}

/** Persist one conversational message; returns the created message id. */
type ConversationPostMessage = (m: {
  fromAgentId: string
  toAgentId?: string
  taskId?: string
  type: 'task' | 'result' | 'status' | 'error'
  text: string
  requiresResponse?: boolean
  payload?: unknown
}) => Promise<string>

/** Live conversational state handed to a worker node under a conversational supervisor. */
type ConversationNodeState = {
  conversational: boolean
  counters: ConversationCounters
  postMessage: ConversationPostMessage
  transcript: { from: string; to: string; text: string }[]
}

/** One supervisor decision turn (parsed from LLM JSON). */
export type SupervisorDecision =
  | { decision: 'done'; reason?: string }
  | { decision: 'ask'; to: string; question: string; reason?: string }

/**
 * Parse one supervisor decision turn from LLM output text. The supervisor
 * returns ONLY JSON: {"decision":"done","reason":"..."} when the job is
 * complete, or {"decision":"ask","to":"<agent id | role | name>",
 * "question":"..."} to ask one assigned agent one question.
 * Unparsable output, or a decision that is not a well-formed ask, is
 * treated as done — the run ends with the work so far, never on a guess.
 */
export function parseSupervisorDecision(text: string): SupervisorDecision {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const candidates = [cleaned]
  const block = cleaned.match(/\{[\s\S]*\}/)
  if (block && block[0] !== cleaned) candidates.push(block[0])
  for (const candidate of candidates) {
    try {
      const raw: unknown = JSON.parse(candidate)
      if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>
        if (
          obj.decision === 'ask' &&
          typeof obj.to === 'string' &&
          obj.to.trim() &&
          typeof obj.question === 'string' &&
          obj.question.trim()
        ) {
          return {
            decision: 'ask',
            to: obj.to,
            question: obj.question,
            reason: typeof obj.reason === 'string' ? obj.reason : undefined,
          }
        }
        if (obj.decision === 'done') {
          return {
            decision: 'done',
            reason: typeof obj.reason === 'string' ? obj.reason : undefined,
          }
        }
      }
    } catch {
      // Try the next candidate; unparsable output falls through to done.
    }
  }
  return { decision: 'done', reason: 'Supervisor decision was not parseable JSON; ending with the work so far.' }
}

/**
 * Group pending plan tasks into topological waves (levels). A task's level
 * is 1 + the highest level of its dependencies; tasks in one wave never
 * depend on each other, so a wave can run through the bounded scheduler
 * together. Dependencies on already-executed tasks count as satisfied.
 */
export function conversationWaveLevels(
  tasks: SupervisorPlanTask[],
): SupervisorPlanTask[][] {
  const byId = new Map(tasks.map((t) => [t.temporaryId, t]))
  const levelOf = new Map<string, number>()
  const level = (id: string, seen: Set<string>): number => {
    const cached = levelOf.get(id)
    if (cached !== undefined) return cached
    // A dependency outside the pending set is already executed (or was
    // dropped, which validation forbids for executed tasks and the caller
    // filters for pending ones) — it contributes level -1, i.e. satisfied.
    const task = byId.get(id)
    if (!task || seen.has(id)) return 0
    seen.add(id)
    const lvl =
      task.dependsOn.length === 0
        ? 0
        : 1 + Math.max(...task.dependsOn.map((d) => level(d, seen)))
    seen.delete(id)
    levelOf.set(id, lvl)
    return lvl
  }
  const waves: SupervisorPlanTask[][] = []
  for (const task of tasks) {
    const lvl = level(task.temporaryId, new Set())
    while (waves.length <= lvl) waves.push([])
    waves[lvl].push(task)
  }
  return waves.filter((w) => w.length > 0)
}

type ConversationalRunArgs = {
  userId: string
  workflowRunId: string
  plan: SupervisorPlan
  agents: Agent[]
  options: {
    originalInput?: string
    getMessageCount?: () => Promise<number>
    isCancelled?: () => Promise<boolean>
    maxExchanges?: number
    timeBudgetMs?: number
  }
}

/**
 * Execute a supervisor plan conversationally: run the plan in topological
 * waves, and after each wave let the supervisor ask one assigned agent a
 * question, receive the answer, and re-plan from it before the next wave.
 *
 * Bounds (never infinite): hard turn cap (default 10 exchanges/run),
 * per-run time budget (default 5 minutes), cancellation. Hitting a bound
 * ends the run honestly with the work so far — pending tasks are listed in
 * the summary, never silently completed.
 */
async function executeConversationalSupervisorPlan(
  userId: string,
  workflowRunId: string,
  initialPlan: SupervisorPlan,
  agents: Agent[],
  options: ConversationalRunArgs['options'],
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
  conversation: SupervisorConversationSummary
}> {
  const { createMessage } = await import('./messageBus')
  // A cyclic initial plan is refused outright (the orchestrator also
  // validates before calling; this guards direct callers the same way the
  // fixed path's topologicalSort does).
  if (hasPlanCycle(initialPlan.tasks)) {
    throw new Error('Supervisor plan has a dependency cycle or an unresolvable dependency.')
  }
  const maxExchanges =
    options.maxExchanges ?? MAX_CONVERSATION_EXCHANGES
  const timeBudgetMs =
    options.timeBudgetMs ?? DEFAULT_CONVERSATION_TIME_BUDGET_MS
  const startedAt = Date.now()
  const timeLeft = () => timeBudgetMs - (Date.now() - startedAt)

  const agentById = new Map(agents.map((a) => [String(a._id), a]))
  const agentSummaries: AgentSummary[] = agents.map((a) => ({
    id: String(a._id),
    name: a.name,
    role: a.role,
    capabilities: (a.capabilities || []).map((cap) => cap.name),
  }))

  let currentPlan: SupervisorPlan = initialPlan
  const taskIdByTempId = new Map<string, string>()
  const executedTaskIds = new Set<string>()
  const droppedTaskIds = new Set<string>()
  const counters: ConversationCounters = {
    exchanges: 0,
    questionsAsked: 0,
    planRevisions: 0,
    messagesCreated: 0,
  }
  let rounds = 0
  let endedBecause: ConversationEndReason = 'final'
  let completed = 0
  let failed = 0
  let finalOutput: Record<string, unknown> = {}
  /** Transcript of the supervisor/agent conversation, in order. */
  const transcript: { from: string; to: string; text: string }[] = []
  let lastMessageId: string | undefined

  const postMessage = async (args: {
    fromAgentId: string
    toAgentId?: string
    taskId?: string
    type: 'task' | 'result' | 'status' | 'error'
    text: string
    requiresResponse?: boolean
    payload?: unknown
  }): Promise<string> => {
    const created = await createMessage({
      userId,
      workflowId: workflowRunId,
      workflowRunId,
      fromAgentId: args.fromAgentId,
      toAgentId: args.toAgentId,
      taskId: args.taskId,
      parentMessageId: lastMessageId,
      type: args.type,
      text: args.text,
      payload: args.payload,
      requiresResponse: args.requiresResponse ?? false,
    })
    counters.messagesCreated += 1
    lastMessageId = String(created._id)
    return lastMessageId
  }

  const pendingTasks = () =>
    currentPlan.tasks.filter(
      (t) => !executedTaskIds.has(t.temporaryId) && !droppedTaskIds.has(t.temporaryId),
    )

  const summary = (): SupervisorConversationSummary => ({
    exchanges: counters.exchanges,
    rounds,
    questionsAsked: counters.questionsAsked,
    planRevisions: counters.planRevisions,
    droppedTaskIds: [...droppedTaskIds],
    endedBecause,
    pendingTaskIds: pendingTasks().map((t) => t.temporaryId),
  })

  const finish = async () => {
    const conversation = summary()
    await updateSharedContext(userId, workflowRunId, {
      variables: { supervisorConversation: conversation },
    }).catch(() => undefined)
    return {
      completed,
      failed,
      messagesCreated: counters.messagesCreated,
      finalOutput,
      conversation,
    }
  }

  // ── Run one wave of pending tasks ──────────────────────────────────
  const runWave = async (wave: SupervisorPlanTask[]) => {
    // Create task rows in topological order (deps are in earlier waves).
    for (const task of wave) {
      const agent = agentById.get(task.agentId) ?? null
      const dependsOnTaskIds: string[] = []
      for (const depTempId of task.dependsOn) {
        const depTaskId = taskIdByTempId.get(depTempId)
        if (!depTaskId) {
          throw new Error(
            `Supervisor plan task "${task.temporaryId}" depends on "${depTempId}", which was not created. The plan is invalid; refusing to run a dependent without its dependency.`,
          )
        }
        dependsOnTaskIds.push(depTaskId)
      }
      const created = await createTask({
        userId,
        workflowRunId,
        agentId: agent?._id ?? 'system',
        title: task.description.slice(0, 120),
        description: task.description,
        input: {},
        dependsOnTaskIds,
        maxRetries: 3,
      })
      taskIdByTempId.set(task.temporaryId, String(created._id))
    }

    // Each wave gets its own scheduleParallel call, and the scheduler only
    // tracks completion inside that call — so a dependency on a task from
    // an earlier wave would never read as met and the wave would silently
    // never run (depsMet is false forever, the scheduler breaks with
    // nothing started). Dependencies on earlier waves are already
    // executed (waves run in topological order), so only in-wave
    // dependencies are passed to the scheduler. The task rows created
    // above keep the real dependsOnTaskIds for the record.
    const waveTempIds = new Set(wave.map((t) => t.temporaryId))
    const schedulableTasks = wave.map((task) => {
      const taskId = taskIdByTempId.get(task.temporaryId)!
      const agent = agentById.get(task.agentId) ?? null
      return {
        id: taskId,
        dependsOnTaskIds: task.dependsOn
          .filter((d) => waveTempIds.has(d))
          .map((d) => taskIdByTempId.get(d))
          .filter((id): id is string => Boolean(id)),
        execute: async () => {
          const node = {
            id: task.temporaryId,
            name: task.description.slice(0, 80),
            type: 'supervisor_task' as const,
            description: task.description,
            config: {},
          }
          const shared = await getSharedContext(userId, workflowRunId)
          const previousResults: Record<string, unknown> = {
            ...(shared.intermediateResults ?? {}),
          }
          return runSupervisorNode(
            taskId,
            userId,
            workflowRunId,
            { node, agent },
            task.expectedOutput,
            options.originalInput ?? '',
            previousResults,
            { conversational: true, counters, postMessage, transcript },
          )
        },
      }
    })

    const schedule = await scheduleParallel(schedulableTasks, {
      ...SUPERVISOR_SCHEDULER_CONFIG,
      getMessageCount: options.getMessageCount,
      isCancelled: options.isCancelled,
    })

    completed += schedule.completed
    failed += schedule.failed + schedule.cancelled.length
    for (const task of wave) {
      const taskId = taskIdByTempId.get(task.temporaryId)!
      const result = schedule.results.get(taskId)
      executedTaskIds.add(task.temporaryId)
      if (!result) continue
      if (result.ok) {
        finalOutput = { ...finalOutput, [task.temporaryId]: result.output }
      } else {
        finalOutput = {
          ...finalOutput,
          [task.temporaryId]: { error: result.error },
        }
      }
    }
  }

  // ── One supervisor decision round after a wave ─────────────────────
  // Returns false when the run should stop (done / cap / budget / cancel).
  const runRound = async (): Promise<boolean> => {
    if (counters.exchanges >= maxExchanges) {
      endedBecause = 'turn_cap'
      return false
    }
    if (timeLeft() <= 0) {
      endedBecause = 'time_budget'
      return false
    }
    if (options.isCancelled && (await options.isCancelled())) {
      endedBecause = 'cancelled'
      return false
    }
    rounds += 1

    const decision = await askSupervisorDecision({
      userId,
      workflowRunId,
      originalInput: options.originalInput ?? '',
      plan: currentPlan,
      executedTaskIds,
      droppedTaskIds,
      results: finalOutput,
      transcript,
      agents: agentSummaries,
    })
    if (decision.decision === 'done') {
      endedBecause = 'final'
      if (decision.reason) {
        await postMessage({
          fromAgentId: SUPERVISOR_SENDER_ID,
          type: 'status',
          text: `Supervisor finished the job: ${decision.reason}`,
        })
      }
      return false
    }

    // ── Ask the agent ────────────────────────────────────────────────
    let recipient: AgentSummary
    try {
      recipient = resolveTurnRecipient(decision.to, agentSummaries)
    } catch (error) {
      await postMessage({
        fromAgentId: SUPERVISOR_SENDER_ID,
        type: 'error',
        text: `Supervisor question could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
      })
      endedBecause = 'final'
      return false
    }
    const recipientAgent = agentById.get(recipient.id) ?? null
    if (counters.exchanges >= maxExchanges || timeLeft() <= 0) {
      endedBecause =
        counters.exchanges >= maxExchanges ? 'turn_cap' : 'time_budget'
      return false
    }
    counters.questionsAsked += 1
    const questionId = await postMessage({
      fromAgentId: SUPERVISOR_SENDER_ID,
      toAgentId: recipient.id,
      type: 'task',
      text: decision.question,
      requiresResponse: true,
      payload: { round: rounds, reason: decision.reason },
    })
    transcript.push({
      from: SUPERVISOR_SENDER_ID,
      to: recipient.name,
      text: decision.question,
    })

    let answer: string
    try {
      answer = await askAgentQuestion({
        userId,
        workflowRunId,
        originalInput: options.originalInput ?? '',
        question: decision.question,
        questionMessageId: questionId,
        agent: recipientAgent,
        results: finalOutput,
        transcript,
        counters,
        postMessage,
      })
    } catch (error) {
      // The agent could not answer (e.g. no provider answered): end the
      // rounds honestly with the work so far; the plan still runs.
      await postMessage({
        fromAgentId: SUPERVISOR_SENDER_ID,
        type: 'error',
        text: `Supervisor question went unanswered — ending rounds: ${error instanceof Error ? error.message : String(error)}`,
      })
      endedBecause = 'final'
      return false
    }
    counters.exchanges += 1
    transcript.push({
      from: recipient.name,
      to: SUPERVISOR_SENDER_ID,
      text: answer,
    })
    await postMessage({
      fromAgentId: recipient.id,
      toAgentId: SUPERVISOR_SENDER_ID,
      type: 'result',
      text: answer,
      payload: { round: rounds, inReplyTo: questionId },
    })

    // ── Re-plan from the answer ──────────────────────────────────────
    const revised = await askSupervisorReplan({
      userId,
      workflowRunId,
      originalInput: options.originalInput ?? '',
      plan: currentPlan,
      executedTaskIds,
      droppedTaskIds,
      results: finalOutput,
      transcript,
      agents: agentSummaries,
    })
    if (!revised) return true // Supervisor kept the current plan.
    const validation = validateReplan({
      previousPlan: currentPlan,
      revisedPlan: revised,
      droppedTaskIds,
      executedTaskIds,
      agents: agentSummaries,
    })
    if (!validation.valid) {
      await postMessage({
        fromAgentId: SUPERVISOR_SENDER_ID,
        type: 'error',
        text: `Supervisor re-plan rejected — ending rounds with the current plan: ${validation.errors.join('; ')}`,
      })
      endedBecause = 'final'
      return false
    }
    for (const id of validation.newlyDropped) droppedTaskIds.add(id)
    currentPlan = revised
    counters.planRevisions += 1
    await postMessage({
      fromAgentId: SUPERVISOR_SENDER_ID,
      type: 'status',
      text: `Supervisor revised the plan (revision ${counters.planRevisions})${validation.newlyDropped.length ? `; dropped: ${validation.newlyDropped.join(', ')}` : ''}.`,
      payload: { planRevisions: counters.planRevisions, dropped: validation.newlyDropped },
    })
    return true
  }

  // ── Waves + rounds ─────────────────────────────────────────────────
  // A 'final' decision (supervisor done, question unanswered, or an
  // invalid re-plan) ends the *rounds* only — the remaining waves still
  // run. Only the hard bounds (turn cap / time budget / cancel) stop the
  // run itself, with pending tasks listed honestly in the summary.
  let roundsDone = false
  for (;;) {
    if (options.isCancelled && (await options.isCancelled())) {
      endedBecause = 'cancelled'
      break
    }
    const waves = conversationWaveLevels(pendingTasks())
    if (waves.length === 0) {
      endedBecause = 'final'
      break
    }
    await runWave(waves[0])
    if (pendingTasks().length === 0) {
      // Last wave done — one final round lets the supervisor ask about
      // the results before deciding the job is done.
      await runRound()
      break
    }
    if (roundsDone) continue
    const keepGoing = await runRound()
    if (keepGoing) continue
    if (endedBecause === 'final') {
      roundsDone = true
      continue
    }
    break
  }

  return finish()
}

/** Shared context handed to the supervisor's decision / re-plan calls. */
type SupervisorRoundContext = {
  userId: string
  workflowRunId: string
  originalInput: string
  plan: SupervisorPlan
  executedTaskIds: ReadonlySet<string>
  droppedTaskIds: ReadonlySet<string>
  results: Record<string, unknown>
  transcript: { from: string; to: string; text: string }[]
  agents: AgentSummary[]
}

function describePlanForSupervisor(ctx: SupervisorRoundContext): string {
  const lines = ctx.plan.tasks.map((t) => {
    const status = ctx.executedTaskIds.has(t.temporaryId)
      ? 'EXECUTED'
      : ctx.droppedTaskIds.has(t.temporaryId)
        ? 'DROPPED'
        : 'PENDING'
    return `- ${t.temporaryId} [${status}] agent ${t.agentId}: ${t.description} (depends on: ${t.dependsOn.join(', ') || 'none'}; expected: ${t.expectedOutput})`
  })
  const results = Object.entries(ctx.results)
    .map(([id, output]) => `Result from task "${id}":\n${String(output).slice(0, 2000)}`)
    .join('\n\n---\n\n')
  const conversation = ctx.transcript
    .map((m) => `${m.from} -> ${m.to}: ${m.text}`)
    .join('\n')
  return [
    `Objective: ${ctx.plan.objective}`,
    `Completion criteria: ${ctx.plan.completionCriteria.join('; ') || 'none stated'}`,
    `Current plan:\n${lines.join('\n')}`,
    results ? `Results so far:\n${results}` : 'No results yet.',
    conversation ? `Conversation so far:\n${conversation}` : 'No conversation yet.',
  ].join('\n\n')
}

/** Ask the supervisor LLM whether the job is done or which agent to question. */
async function askSupervisorDecision(
  ctx: SupervisorRoundContext,
): Promise<SupervisorDecision> {
  const agentList = ctx.agents
    .map((a) => `- ${a.name} (${a.id}) [role: ${a.role || 'general'}]`)
    .join('\n')
  const completion = await chatCompletion({
    system: `You are the supervisor leading a team of agents on one job. After each round of work you decide: either the job is done, or you ask ONE assigned agent ONE question about its task or result, so you can re-plan from the answer.

Return ONLY valid JSON, no other text:
- Job done: {"decision":"done","reason":"<why the job is complete>"}
- Ask a question: {"decision":"ask","to":"<agent id | role | name>","question":"<one specific question>","reason":"<why this question matters>"}

Rules:
- Ask at most one question per turn, and only an agent from the list below.
- Only decide the job is done when the objective and completion criteria are met by the results so far.
- Do not invent agents, tasks, or results.

Assigned agents:
${agentList}`,
    prompt: `${ctx.originalInput ? `Original request: ${ctx.originalInput}\n\n` : ''}${describePlanForSupervisor(ctx)}\n\nDecide: done, or ask one question? Return ONLY the JSON decision.`,
    maxTokens: 512,
    temperature: 0.3,
    timeoutMs: 30_000,
  })
  if (!completion.ok) {
    // No provider answered the decision call: end honestly with the work
    // so far rather than guessing a question or a completion.
    return { decision: 'done', reason: 'Supervisor decision call had no provider answer; ending with the work so far.' }
  }
  return parseSupervisorDecision(completion.text)
}

/**
 * Ask one agent the supervisor's question and return its final answer.
 * The agent answers in the frozen turn format; if it asks a question back,
 * the supervisor answers once and the agent is asked again for its final
 * answer (one follow-up only, then the result stands).
 */
async function askAgentQuestion(args: {
  userId: string
  workflowRunId: string
  originalInput: string
  question: string
  questionMessageId: string
  agent: Agent | null
  results: Record<string, unknown>
  transcript: { from: string; to: string; text: string }[]
  counters: ConversationCounters
  postMessage: ConversationPostMessage
}): Promise<string> {
  const prior = Object.entries(args.results)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([taskId, output]) => `Result from task "${taskId}":\n${String(output).slice(0, 2000)}`)
    .join('\n\n---\n\n')
  const conversation = args.transcript
    .map((m) => `${m.from} -> ${m.to}: ${m.text}`)
    .join('\n')
  const agentPrompt = args.agent?.systemPrompt?.trim()
    ? `${args.agent.systemPrompt.trim()}\n\n`
    : ''
  const system = `${agentPrompt}You are a worker agent answering a question from your supervisor during a team run.

Answer the question directly and completely, using the results and conversation below as context.

Reply with ONLY JSON in the frozen turn format:
- Final answer: {"kind":"final","text":"<your answer>"}
- If you genuinely cannot answer without one piece of information from the supervisor: {"kind":"message","to":"supervisor","text":"<your question>","requiresResponse":true}
Do not message any other agent.`
  const prompt = [
    args.originalInput ? `Original request: ${args.originalInput}` : '',
    prior ? `Results from earlier tasks:\n${prior}` : '',
    conversation ? `Conversation so far:\n${conversation}` : '',
    `Supervisor's question: ${args.question}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const callAgent = async (extraPrompt?: string) =>
    chatCompletion({
      system,
      prompt: extraPrompt ? `${prompt}\n\n${extraPrompt}` : prompt,
      maxTokens: args.agent?.maxTokenBudget ?? 2048,
      temperature: 0.4,
    })

  const completion = await callAgent()
  if (!completion.ok) {
    throw new Error(
      `Agent did not answer the supervisor's question: ${completion.failures?.map((f) => f.message).join('; ') || 'no provider answered'}`,
    )
  }
  const turn = parseSupervisorTurn(completion.text)
  if (turn.kind === 'final') return turn.text

  // The agent asked a question back: the supervisor answers once, then the
  // agent is asked again for its final answer. One follow-up only.
  await args.postMessage({
    fromAgentId: args.agent?._id ?? 'system',
    toAgentId: SUPERVISOR_SENDER_ID,
    type: 'task',
    text: turn.text,
    requiresResponse: true,
    payload: { inReplyTo: args.questionMessageId, askBack: true },
  })
  const reply = await chatCompletion({
    system: `You are the supervisor leading a team of agents. One agent asked you a question while answering yours. Answer it briefly and directly, in plain text, so the agent can finish its answer. Do not ask a question back.`,
    prompt: `Agent's question: ${turn.text}\n\nOriginal request: ${args.originalInput}\n\nYour question to the agent: ${args.question}`,
    maxTokens: 512,
    temperature: 0.3,
    timeoutMs: 30_000,
  })
  const supervisorReply = reply.ok
    ? reply.text
    : 'No answer available — proceed with your best answer from the context you have.'
  await args.postMessage({
    fromAgentId: SUPERVISOR_SENDER_ID,
    toAgentId: args.agent?._id ?? 'system',
    type: 'result',
    text: supervisorReply,
    payload: { inReplyTo: args.questionMessageId, askBack: true },
  })
  args.counters.exchanges += 1
  const second = await callAgent(
    `Supervisor's answer to your question: ${supervisorReply}\n\nNow give your final answer to the supervisor's original question.`,
  )
  if (!second.ok) {
    throw new Error(
      `Agent did not answer after the supervisor's reply: ${second.failures?.map((f) => f.message).join('; ') || 'no provider answered'}`,
    )
  }
  return parseSupervisorTurn(second.text).text
}

/**
 * Ask the supervisor LLM to revise the plan from the conversation so far.
 * Returns the revised plan, or null when the supervisor keeps the current
 * plan ({"keep":true} or unparsable output — keeping the plan is the safe
 * default; a re-plan that cannot be parsed is never applied).
 */
async function askSupervisorReplan(
  ctx: SupervisorRoundContext,
): Promise<SupervisorPlan | null> {
  const agentList = ctx.agents
    .map((a) => `- ${a.name} (${a.id}) [role: ${a.role || 'general'}]`)
    .join('\n')
  const completion = await chatCompletion({
    system: `You are the supervisor leading a team of agents. An agent just answered your question. Revise the execution plan from the answers: you may revise the description or expected output of PENDING tasks, add a follow-up task, or drop a PENDING task the answer showed unnecessary.

Return ONLY valid JSON, no other text:
- Keep the current plan unchanged: {"keep":true}
- Revised plan: the full plan as JSON matching the original schema: {"objective":"...","tasks":[{"temporaryId":"...","agentId":"...","description":"...","dependsOn":[...],"expectedOutput":"..."}],"completionCriteria":[...]}

Rules:
- NEVER drop or change a task marked EXECUTED — it already ran.
- NEVER bring back a task marked DROPPED.
- New tasks need a fresh temporaryId (t-new-1, t-new-2, ...) and an agent from the list below.
- dependsOn may only reference temporaryIds in the revised plan; no cycles.
- Keep the task count at or below 10.

Agents:
${agentList}`,
    prompt: `${ctx.originalInput ? `Original request: ${ctx.originalInput}\n\n` : ''}${describePlanForSupervisor(ctx)}\n\nRevise the plan from the answers, or keep it. Return ONLY the JSON.`,
    maxTokens: 2048,
    temperature: 0.3,
    timeoutMs: 30_000,
  })
  if (!completion.ok) return null
  try {
    const raw: unknown = JSON.parse(
      completion.text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    )
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    if (!Array.isArray(obj.tasks)) return null
    return parseSupervisorPlan(completion.text)
  } catch {
    return null
  }
}

/**
 * Execute a single supervisor-plan task node.
 *
 * Builds a prompt from the task description and expected output, calls the
 * LLM, writes the result to shared context, and emits a result message.
 */
async function runSupervisorNode(
  taskId: string,
  userId: string,
  workflowRunId: string,
  { node, agent }: { node: { id: string; name: string; description: string; type: string; config?: Record<string, unknown> }; agent: Agent | null },
  expectedOutput: string,
  originalInput: string,
  previousResults: Record<string, unknown>,
  conversation?: ConversationNodeState,
): Promise<NodeExecutionResult> {
  const { createMessage } = await import('./messageBus')
  const { updateSharedContext } = await import('./contextManager')
  const { completeTask, failTask } = await import('./taskManager')
  const start = Date.now()

  try {
    const prior = Object.entries(previousResults)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([taskId, output]) => `Result from task "${taskId}":\n${String(output)}`)
      .join('\n\n---\n\n')
    const agentPrompt = agent?.systemPrompt?.trim() ? `${agent.systemPrompt.trim()}\n\n` : ''
    // The "Do not delegate" instruction is softened ONLY for agents under
    // a conversational supervisor: they may ask the supervisor one
    // question back (frozen turn format). The fixed-plan path keeps the
    // instruction exactly as it was.
    const closing = conversation?.conversational
      ? 'If you genuinely need one piece of information from the supervisor to complete this task, reply with ONLY this JSON: {"kind":"message","to":"supervisor","text":"<your question>","requiresResponse":true}. Otherwise produce the result directly. Do not message any other agent.'
      : 'Produce the result directly. Do not ask questions. Do not delegate.'
    const system = `${agentPrompt}You are a worker agent executing a supervisor-assigned task.

Task: ${node.description}
Expected output: ${expectedOutput}

${closing}`
    const prompt = [
      originalInput ? `Original request: ${originalInput}` : '',
      prior ? `Results from earlier tasks:\n${prior}` : '',
      `Complete the task described above and produce the expected output.`,
    ]
      .filter(Boolean)
      .join('\n\n')

    const completion = await chatCompletion({
      system,
      prompt,
      maxTokens: agent?.maxTokenBudget ?? 2048,
      temperature: 0.4,
    })

    if (!completion.ok) {
      const error = `No inference provider answered: ${completion.failures?.map((f) => f.message).join('; ') || 'unknown'}`
      await failTask(taskId, userId, workflowRunId, error)
      await createMessage({
        userId,
        workflowId: workflowRunId,
        workflowRunId,
        fromAgentId: agent?._id ?? 'system',
        toAgentId: undefined,
        taskId,
        type: 'error',
        text: error,
        priority: 'high',
      })
      return {
        nodeId: node.id,
        ok: false,
        error,
        durationMs: Date.now() - start,
        provider: null,
        model: null,
      }
    }

    let output = completion.text

    // Conversational only: the agent may have asked the supervisor a
    // question back instead of a result. One supervisor reply + one agent
    // retry, then the result stands — never an open-ended loop.
    if (conversation?.conversational) {
      const turn = parseSupervisorTurn(completion.text)
      if (turn.kind === 'final') {
        output = turn.text
      } else {
        conversation.transcript.push({
          from: agent?.name ?? 'agent',
          to: SUPERVISOR_SENDER_ID,
          text: turn.text,
        })
        await conversation.postMessage({
          fromAgentId: agent?._id ?? 'system',
          toAgentId: SUPERVISOR_SENDER_ID,
          taskId,
          type: 'task',
          text: turn.text,
          requiresResponse: true,
          payload: { askBack: true, nodeId: node.id },
        })
        const reply = await chatCompletion({
          system: `You are the supervisor leading a team of agents. One agent asked you a question while working on its task. Answer it briefly and directly, in plain text, so the agent can finish its task. Do not ask a question back.`,
          prompt: `Agent's question: ${turn.text}\n\nTask: ${node.description}\nExpected output: ${expectedOutput}${originalInput ? `\n\nOriginal request: ${originalInput}` : ''}`,
          maxTokens: 512,
          temperature: 0.3,
          timeoutMs: 30_000,
        })
        const supervisorReply = reply.ok
          ? reply.text
          : 'No answer available — proceed with your best result from the context you have.'
        conversation.transcript.push({
          from: SUPERVISOR_SENDER_ID,
          to: agent?.name ?? 'agent',
          text: supervisorReply,
        })
        await conversation.postMessage({
          fromAgentId: SUPERVISOR_SENDER_ID,
          toAgentId: agent?._id ?? 'system',
          taskId,
          type: 'result',
          text: supervisorReply,
          payload: { askBack: true, nodeId: node.id },
        })
        conversation.counters.exchanges += 1
        const second = await chatCompletion({
          system,
          prompt: `${prompt}\n\nSupervisor's answer to your question: ${supervisorReply}\n\nNow produce the result for the task.`,
          maxTokens: agent?.maxTokenBudget ?? 2048,
          temperature: 0.4,
        })
        if (second.ok) {
          // One follow-up only: whatever the agent returns now stands.
          output = parseSupervisorTurn(second.text).text
        }
      }
    }

    await updateSharedContext(userId, workflowRunId, {
      intermediateResults: { [node.id]: output },
    })

    await createMessage({
      userId,
      workflowId: workflowRunId,
      workflowRunId,
      fromAgentId: agent?._id ?? 'system',
      toAgentId: undefined,
      taskId,
      type: 'result',
      text: output,
      payload: {
        nodeId: node.id,
        provider: completion.provider,
        model: completion.model,
      },
    })

    await completeTask(taskId, userId, workflowRunId, output)

    return {
      nodeId: node.id,
      ok: true,
      output,
      durationMs: Date.now() - start,
      provider: completion.provider,
      model: completion.model,
      messages: [],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failTask(taskId, userId, workflowRunId, message)
    return {
      nodeId: node.id,
      ok: false,
      error: message,
      durationMs: Date.now() - start,
      provider: null,
      model: null,
    }
  }
}
