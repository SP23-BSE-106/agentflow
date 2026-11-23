/**
 * Multi-agent orchestrator engine (implementation plan Phase 5 + Phase 6).
 *
 * Responsible for executing a workflow graph as a set of cooperating agents.
 * Supports three modes:
 *   - sequential: nodes execute one after another in topological order.
 *   - parallel: independent branches run concurrently with bounded
 *     concurrency; aggregator nodes wait for all their dependencies.
 *   - supervisor: a supervisor agent generates a structured execution plan
 *     from a natural-language request, then executes it.
 *   - team: the agents named by the workflow's nodes work the job
 *     together, talking to each other in a turn-taking conversation loop
 *     (see teamLoop.ts).
 *
 * Modules it composes:
 *   - taskManager         — task lifecycle (pending → running → completed/failed)
 *   - messageBus          — structured agent-to-agent messages
 *   - contextManager      — shared run context (intermediate results, decisions)
 *   - dependencyResolver  — topological order + cycle detection
 *   - scheduler           — bounded-concurrency parallel execution
 *   - supervisor          — plan generation, validation, execution
 */

import { getDb } from '@/lib/mongo/mongo'
import { ObjectId } from 'mongodb'
import { getExecutionBudget } from '@/lib/permissions'

import { completeTask, createTask, failTask, updateTaskStatus } from './taskManager'
import { createMessage } from './messageBus'
import { getSharedContext, getTeamTurnContext, updateSharedContext } from './contextManager'
import { topologicalSort } from './dependencyResolver'
import { scheduleParallel, type SchedulerConfig } from './scheduler'
import {
  executeSupervisorPlan,
  generateSupervisorPlan,
  listAvailableAgents,
  validateSupervisorPlan,
} from './supervisor'
import {
  decideRecovery,
  DEFAULT_RETRY_POLICY,
  evaluateTaskOutput,
  isReviewExhausted,
  retryTaskWithFeedback,
} from './evaluator'
import {
  createApprovalRequest,
} from './approvalManager'
import { chooseBranchEdge } from '@/lib/workflow/branching'
import {
  collectDownstreamIds,
  evaluateCondition,
} from '@/lib/workflow/condition'
import { resolveNodeAgents, referencedAgentIds } from './resolveNodes'
import { runTeamConversation } from './teamLoop'
import type { TeamAgent } from './teamTypes'
import { runWorkflowNode } from '@/lib/workflow/nodeRunner'
import { parseTopK } from '@/lib/rag/grounding'
// Renamed on import: this file also has a local `skippedNodeIds` Set (the
// sequential loop's prune list). The function computes the same set from
// recorded Condition outcomes; the parallel branch uses it.
import { skippedNodeIds as skippedBranchNodeIds } from '@/lib/workflow/branching'
import type {
  AgentExecutionContext,
  NodeExecutionResult,
  OrchestrationRequest,
  OrchestrationResult,
  ResolvedNode,
} from './types'
import type { Agent } from '@/lib/mongo/agent'
import type { AgentTask } from '@/lib/mongo/agentTasks'
import type { WorkflowGraph, WorkflowNode } from '@/lib/mongo/workflow'

/**
 * Default scheduler configuration for parallel runs.
 */
const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  maxConcurrentTasks: 5,
  maxRunDurationMs: 300_000, // 5 minutes
  maxMessagesPerRun: 500,
}

/**
 * Output-approval gate (Phase 11), checked AFTER a node succeeds.
 *
 * The pre-execution checkpoint in the sequential loop only fires when a
 * task row already exists for the node, so on a first run — where no task
 * exists yet — it never fires and an approval-required agent runs straight
 * through with no approval request at all (proven live 2026-11-18: a
 * humanApprovalRequired run completed with zero approval_requests rows).
 * The approval is of the node's produced output, so the gate belongs here,
 * once the output exists: if this node's agent requires human approval and
 * no approval exists for its task yet, create one and pause the run. On
 * resume the completed-task skip above reuses the approved output and the
 * run continues downstream — no second approval is created, because the
 * skip fires before this gate is reached again.
 */
async function pauseForOutputApproval(args: {
  userId: string
  runId: string
  node: WorkflowNode
  agent: Agent | null | undefined
  taskId: string
  previousResults: Record<string, unknown>
  finalOutput: unknown
  tasksCompleted: number
  tasksFailed: number
  messagesCreated: number
  startedAt: number
}): Promise<OrchestrationResult | null> {
  const { userId, runId, node, agent, taskId } = args
  if (!agent?.humanApprovalRequired) return null
  const db = await getDb()
  const existing = await db.collection('approval_requests').findOne({
    userId,
    workflowRunId: runId,
    taskId,
  })
  // An approval already exists for this output: pending means we are still
  // paused; approved/edited means the user already signed it off. REJECTED
  // is neither — a rejected output must never be used, so the run fails
  // here instead of sailing through as if it had been approved (C2: the
  // old code returned null for every non-pending status, rejected included).
  if (existing) {
    if (existing.status === 'pending') {
      return {
        runId,
        status: 'paused',
        output: args.finalOutput,
        tasksCompleted: args.tasksCompleted,
        tasksFailed: args.tasksFailed,
        messagesCreated: args.messagesCreated,
        durationMs: Date.now() - args.startedAt,
      }
    }
    if (existing.status === 'rejected') {
      return failRunWithReason({
        db,
        userId,
        runId,
        reason: `Approval for the output of "${node.name}" was rejected${rejectionNote(existing.response)}. The rejected output cannot be used, so the run is stopped here.`,
        tasksCompleted: args.tasksCompleted,
        tasksFailed: args.tasksFailed,
        messagesCreated: args.messagesCreated,
        startedAt: args.startedAt,
      })
    }
    return null
  }
  // H1 — one human decision governs the whole run. If an earlier node was
  // already approved (or its output edited-and-approved), this run is
  // signed off: never mint a second approval for a later node. If an
  // earlier node was rejected, the run is terminal-failed (resumeRun
  // normally catches this first; this is the direct-orchestrate defence).
  // If another node's approval is still pending, stay paused on that one.
  const runApproval = await latestApprovalForRun(db, userId, runId)
  if (runApproval) {
    if (runApproval.status === 'pending') {
      return {
        runId,
        status: 'paused',
        output: args.finalOutput,
        tasksCompleted: args.tasksCompleted,
        tasksFailed: args.tasksFailed,
        messagesCreated: args.messagesCreated,
        durationMs: Date.now() - args.startedAt,
      }
    }
    if (runApproval.status === 'rejected') {
      return failRunWithReason({
        db,
        userId,
        runId,
        reason: `Approval for this run was rejected${rejectionNote(runApproval.response)}. The rejected output cannot be used, so the run is stopped here.`,
        tasksCompleted: args.tasksCompleted,
        tasksFailed: args.tasksFailed,
        messagesCreated: args.messagesCreated,
        startedAt: args.startedAt,
      })
    }
    // approved / edited: the run is already signed off — no fresh approval.
    return null
  }
  await createApprovalRequest({
    userId,
    workflowRunId: runId,
    taskId,
    requestedByAgentId: agent._id,
    title: `Approve output from "${node.name}"`,
    description: node.description || 'Human approval required before this agent output is used.',
    payload: { nodeId: node.id, previousResults: args.previousResults },
  })
  return {
    runId,
    status: 'paused',
    output: args.finalOutput,
    tasksCompleted: args.tasksCompleted,
    tasksFailed: args.tasksFailed,
    messagesCreated: args.messagesCreated,
    durationMs: Date.now() - args.startedAt,
  }
}

/**
 * The latest rejected approval for a run, if any. A rejection is terminal
 * for the output it covers: there is no re-request path, so a run carrying
 * one must never resume or reuse that output (C2).
 */
async function rejectedApprovalForRun(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await db
    .collection('approval_requests')
    .find({ userId, workflowRunId: runId, status: 'rejected' })
    .sort({ respondedAt: -1, updatedAt: -1 })
    .limit(1)
    .toArray()) as unknown as Record<string, unknown>[]
  return rows[0] ?? null
}

/**
 * The latest approval for a run in any status, if any. H1: one human
 * decision governs the whole run, so the gate sites consult this before
 * minting a fresh approval — an approved/edited run never re-pauses, a
 * rejected run never resumes, a pending run stays paused on the approval
 * that already exists.
 */
async function latestApprovalForRun(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await db
    .collection('approval_requests')
    .find({ userId, workflowRunId: runId })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()) as unknown as Record<string, unknown>[]
  return rows[0] ?? null
}

/**
 * Render a rejection response inside a sentence without doubling its final
 * full stop ("…output." + "." = "…output..").
 */
function rejectionNote(response: unknown): string {
  if (typeof response !== 'string' || !response.trim()) return ''
  return `: ${response.trim().replace(/[.]+$/, '')}`
}

/**
 * Terminal-fail a run in the store and return the matching result, with the
 * reason recorded on the run and in the trace — so a run stopped by a
 * rejected approval says why instead of looking paused forever or, worse,
 * completed. Early returns from `orchestrate` bypass the finalise block,
 * so this does the store write the finalise would have done.
 */
async function failRunWithReason(args: {
  db: Awaited<ReturnType<typeof getDb>>
  userId: string
  runId: string
  reason: string
  tasksCompleted: number
  tasksFailed: number
  messagesCreated: number
  startedAt: number
}): Promise<OrchestrationResult> {
  const durationMs = Date.now() - args.startedAt
  await args.db.collection('workflow_runs').updateOne(
    { _id: new ObjectId(args.runId), userId: args.userId },
    {
      $set: {
        status: 'failed',
        output: { error: args.reason },
        finishedAt: new Date(),
        durationMs,
      },
    },
  )
  await args.db.collection('execution_events').insertOne({
    userId: args.userId,
    workflowRunId: args.runId,
    type: 'run.failed',
    payload: {
      reason: args.reason,
      tasksCompleted: args.tasksCompleted,
      tasksFailed: args.tasksFailed,
      messagesCreated: args.messagesCreated,
      durationMs,
    },
    createdAt: new Date(),
  })
  return {
    runId: args.runId,
    status: 'failed',
    output: { error: args.reason },
    tasksCompleted: args.tasksCompleted,
    tasksFailed: args.tasksFailed,
    messagesCreated: args.messagesCreated,
    durationMs,
  }
}

/**
 * Execute one workflow run.
 *
 * Steps:
 *   1. Load the agent and its workflow graph (validate ownership).
 *   2. Create a workflow run record.
 *   3. Resolve each node to its agent, topologically sort (cycle check).
 *   4. Sequential mode: execute nodes one at a time in topological order.
 *   5. Parallel mode: create all tasks up front, then run them through the
 *      bounded-concurrency scheduler.
 *   6. Return the orchestration result.
 */
export async function orchestrate(request: OrchestrationRequest): Promise<OrchestrationResult> {
  const { agentId, input, userId, mode, existingRunId, conversational } = request
  const startedAt = Date.now()

  const db = await getDb()

  // ── 1. Load agent and workflow ───────────────────────────────────────
  const agent = (await db.collection('agents').findOne({
    _id: new ObjectId(agentId),
    userId,
  })) as unknown as Agent
  if (!agent) {
    throw new Error('Agent not found')
  }

  // A resumed run keeps its own stored graph; a fresh run uses the agent's.
  let existingRun: Record<string, unknown> | null = null
  if (existingRunId) {
    existingRun = (await db.collection('workflow_runs').findOne({
      _id: new ObjectId(existingRunId),
      userId,
    })) as unknown as Record<string, unknown> | null
    if (!existingRun) throw new Error('Run not found')
  }

  const graph: WorkflowGraph | null =
    (existingRun?.workflow as WorkflowGraph | null) ?? agent.workflow ?? null
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    throw new Error('Agent has no executable workflow graph')
  }
  const budget = await getExecutionBudget(userId)
  if (graph.nodes.length > budget.maxTasksPerRun) {
    throw new Error(
      `Workflow exceeds the maximum of ${budget.maxTasksPerRun} tasks per run`,
    )
  }

  // H18: one topK source of truth. Explicit request value wins, else the
  // saved workspace default, else 3 — parseTopK clamps to 1..50, the same
  // rule rag/query, /api/execute and the RAG node all use. The old
  // hardcoded topK: 3 in runNodeExecution ignored the saved setting, so
  // "Run helpers together" retrieved 3 while Execute retrieved up to 50.
  // Resumed runs re-enter through orchestrate(), so they resolve the same way.
  const workspaceSettings = await db.collection('workspace_settings').findOne({ userId })
  const effectiveTopK = parseTopK(request.topK ?? workspaceSettings?.defaults?.topK, 3)

  // ── Find a critic / fact-checker agent for quality evaluation (Phase 9) ──
  // Query by role instead of loading the whole collection: the critic is the
  // first agent whose stored role is 'critic' or 'fact_checker'. A critic
  // agent can only be found because POST/PATCH now actually write `role`
  // (P1-1). When there is none, evaluation is skipped — and the run log says
  // so, instead of the run silently looking as if it passed criticism.
  const criticRows = (await db
    .collection('agents')
    .find(
      { userId, role: { $in: ['critic', 'fact_checker'] } },
      { projection: { userApiKey: 0 } },
    )
    .limit(1)
    .toArray()) as unknown as Agent[]
  const critic = criticRows[0] ?? null
  if (!critic) {
    console.warn(`[orchestrate] Run for agent ${agentId}: no critic/fact_checker agent exists for this user, so critic evaluation is skipped. Create an agent with role "critic" to enable it.`)
  }

  // ── 2. Create the workflow run (or reuse the resumed one) ────────────
  const now = new Date()
  let runResult: { insertedId: ObjectId }
  if (existingRun) {
    runResult = { insertedId: existingRun._id as ObjectId }
    await db.collection('workflow_runs').updateOne(
      { _id: new ObjectId(existingRunId!), userId },
      { $set: { status: 'running', updatedAt: now }, $unset: { finishedAt: '' } },
    )
  } else {
    runResult = await db.collection('workflow_runs').insertOne({
      userId,
      agentId,
      workflow: graph,
      input: { text: input },
      status: 'running' as const,
      mode,
      startedAt: now,
      createdAt: now,
      metadata: { mode },
    })
  }
  const runId = String(runResult.insertedId)

  // ── 3. Resolve nodes to agents and validate graph ────────────────────
  // resolveNodes loads every agent a node config names and checks ownership;
  // a reference to an agent that does not exist or is not yours fails the
  // run honestly instead of silently running it as the owner agent.
  let resolved: ResolvedNode[]
  try {
    resolved = await resolveNodes(db, userId, graph.nodes, agent)
  } catch (error) {
    await db
      .collection('workflow_runs')
      .updateOne({ _id: runResult.insertedId, userId }, { $set: { status: 'failed' } })
    throw error
  }
  let orderedIds: string[]
  try {
    orderedIds = topologicalSort(graph.nodes, graph.edges || [])
  } catch (error) {
    await db
      .collection('workflow_runs')
      .updateOne({ _id: runResult.insertedId, userId }, { $set: { status: 'failed' } })
    throw error
  }

  // ── 4. Shared context for this run ──────────────────────────────────
  const sharedContext = await getSharedContext(userId, runId)
  await updateSharedContext(userId, runId, { originalInput: input })
  const isCancelled = async () =>
    Boolean(
      await db.collection('workflow_runs').findOne({
        _id: runResult.insertedId,
        userId,
        status: 'cancelled',
      }),
    )

  // ── 5. Execute nodes ────────────────────────────────────────────────
  const previousResults: Record<string, unknown> = {}
  // Outcomes of Condition nodes so far ('true'/'false'); downstream nodes
  // on the unchosen branch are skipped, in every mode.
  const conditionOutcomes = new Map<string, 'true' | 'false'>()
  let tasksCompleted = 0
  let tasksFailed = 0
  let tasksSkipped = 0
  let messagesCreated = 0
  let finalOutput: unknown = null
  // Nodes pruned by a Condition branch that was not taken. They are never
  // executed and never counted as failures.
  const skippedNodeIds = new Set<string>()
  // Expected completions: the graph size, except supervisor mode counts plan
  // tasks (not graph nodes) and skipped branch nodes do not count at all.
  let expectedCompletions = orderedIds.length

  if (mode === 'parallel') {
    const result = await executeParallel(
      userId,
      runId,
      resolved,
      orderedIds,
      graph.edges || [],
      input,
      previousResults,
      sharedContext,
      budget,
      () =>
        db.collection('agent_messages').countDocuments({ userId, workflowRunId: runId }),
      isCancelled,
      conditionOutcomes,
      effectiveTopK,
    )
    tasksCompleted = result.completed
    tasksFailed = result.failed
    messagesCreated = result.messagesCreated
    finalOutput = result.finalOutput
    expectedCompletions = orderedIds.length - skippedBranchNodeIds(graph.nodes, graph.edges || [], conditionOutcomes).size
  } else if (mode === 'supervisor') {
    const supervisorResult = await executeSupervisorMode(
      userId,
      runId,
      agent,
      input,
      () =>
        db.collection('agent_messages').countDocuments({ userId, workflowRunId: runId }),
      isCancelled,
      conversational,
    )
    tasksCompleted = supervisorResult.completed
    tasksFailed = supervisorResult.failed
    messagesCreated = supervisorResult.messagesCreated
    finalOutput = supervisorResult.finalOutput
    expectedCompletions = supervisorResult.total
  } else if (mode === 'team') {
    // Team mode (multi-agent conversation loop, Lane A): the agents named
    // by the workflow's nodes work the job together, talking to each
    // other. The owner agent leads; every other distinct node agent joins.
    // (Merge note: Lane A's hunk compared `(mode as string) === 'team'`
    // because 'team' was not yet in the types; the merge added 'team' to
    // OrchestrationMode + the zod enum, so the direct comparison applies.)
    const team: TeamAgent[] = []
    const seenTeamIds = new Set<string>()
    const addToTeam = (candidate: Agent | null) => {
      if (!candidate) return
      const id = String(candidate._id)
      if (seenTeamIds.has(id)) return
      seenTeamIds.add(id)
      team.push({
        id,
        name: candidate.name,
        role: candidate.role,
        systemPrompt: candidate.systemPrompt,
        model: candidate.model,
        maxTokenBudget: candidate.maxTokenBudget,
      })
    }
    addToTeam(agent)
    for (const resolvedNode of resolved) addToTeam(resolvedNode.agent)
    const teamResult = await runTeamConversation(
      {
        userId,
        workflowId: runId,
        workflowRunId: runId,
        task: input,
        team,
        timeBudgetMs: budget.maxRunDurationMs,
      },
      { isCancelled },
    )
    tasksCompleted = teamResult.status === 'completed' ? 1 : 0
    tasksFailed = teamResult.status === 'completed' ? 0 : 1
    messagesCreated = teamResult.messagesCreated
    finalOutput =
      teamResult.status === 'completed'
        ? { text: teamResult.finalText, transcript: teamResult.transcript }
        : {
            error: teamResult.note ?? 'Team run did not complete.',
            status: teamResult.status,
            text: teamResult.finalText,
            transcript: teamResult.transcript,
          }
    expectedCompletions = 1
  } else {
    // Sequential mode (Phase 6) with evaluation + recovery (Phase 9 + 10)
    // and human approval checkpoints (Phase 11).
    for (const nodeId of orderedIds) {
      if (await isCancelled()) {
        finalOutput = { error: 'Workflow cancelled' }
        break
      }
      if (Date.now() - startedAt >= budget.maxRunDurationMs) {
        finalOutput = { error: 'Execution duration budget exceeded' }
        break
      }
      const currentMessageCount = await db.collection('agent_messages').countDocuments({
        userId,
        workflowRunId: runId,
      })
      if (currentMessageCount >= budget.maxMessagesPerRun) {
        finalOutput = { error: 'Execution message budget exceeded' }
        break
      }
      const resolvedNode = resolved.find((r) => r.node.id === nodeId)
      if (!resolvedNode) continue

      // Pruned by an earlier Condition branch — never executed.
      // (The parallel branch uses skippedBranchNodeIds() instead; same
      // outcome, computed from conditionOutcomes.)
      if (skippedNodeIds.has(nodeId)) {
        tasksSkipped += 1
        continue
      }

      // ── Skip already-completed tasks (resume after approval pause) ──
      const existingTask = await db
        .collection('agent_tasks')
        .find({ userId, workflowRunId: runId, title: resolvedNode.node.name })
        .sort({ createdAt: -1 })
        .limit(1)
        .toArray()
        .then((rows) => rows[0])

      if (existingTask && existingTask.status === 'completed') {
        // A completed task is only reusable if its output survived human
        // approval. Reusing it blindly is the C2 hole: a run paused for an
        // approval that was then REJECTED resumed straight past the gate,
        // reused the rejected output, and completed as if approved.
        if (resolvedNode.agent?.humanApprovalRequired) {
          const approvalRows = (await db
            .collection('approval_requests')
            .find({
              userId,
              workflowRunId: runId,
              taskId: String(existingTask._id),
            })
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray()) as unknown as Array<Record<string, unknown>>
          const approval = approvalRows[0]
          if (approval?.status === 'rejected') {
            return failRunWithReason({
              db,
              userId,
              runId,
              reason: `Approval for the output of "${resolvedNode.node.name}" was rejected${rejectionNote(approval.response)}. The rejected output cannot be used, so the run is stopped here.`,
              tasksCompleted,
              tasksFailed,
              messagesCreated,
              startedAt,
            })
          }
          if (approval?.status === 'pending') {
            return {
              runId,
              status: 'paused',
              output: finalOutput,
              tasksCompleted,
              tasksFailed,
              messagesCreated,
              durationMs: Date.now() - startedAt,
            }
          }
          // approved / edited / no approval row: the output is usable.
        }
        previousResults[nodeId] = existingTask.output
        finalOutput = existingTask.output
        tasksCompleted += 1
        continue
      }

      // ── Condition branch: real branching, same comparator as /api/execute ──
      // The state is the last output so far (or the original input for the
      // first node). The branch taken follows the edge labelled "true" or
      // "false"; nodes reachable only from the other edges are skipped.
      if (resolvedNode.node.type === 'condition') {
        const stateText =
          finalOutput == null
            ? input
            : typeof finalOutput === 'string'
              ? finalOutput
              : (JSON.stringify(finalOutput) ?? input)
        let branch: boolean
        try {
          branch = evaluateCondition(resolvedNode.node.config, stateText)
        } catch (error) {
          tasksFailed += 1
          finalOutput = {
            error: error instanceof Error ? error.message : 'Invalid condition.',
            failedNode: nodeId,
          }
          break
        }
        const branchText = branch ? 'true' : 'false'
        const conditionTask = await createTask({
          userId,
          workflowRunId: runId,
          agentId: resolvedNode.agent?._id ?? 'system',
          title: resolvedNode.node.name,
          description: resolvedNode.node.description || '',
          input: previousResults,
          dependsOnTaskIds: [],
          maxRetries: 0,
        })
        await completeTask(String(conditionTask._id), userId, runId, branchText)
        await createMessage({
          userId,
          workflowId: runId,
          workflowRunId: runId,
          fromAgentId: resolvedNode.agent?._id ?? 'system',
          toAgentId: undefined,
          taskId: String(conditionTask._id),
          type: 'result',
          text: `Condition evaluated to ${branch}.`,
          payload: { nodeId, branch: branchText },
          priority: 'normal',
        })
        previousResults[nodeId] = branchText
        finalOutput = branchText
        // Record the outcome where it is decided: the post-execution block
        // below never sees a Condition node (they `continue` here), so it
        // cannot populate this map — and TypeScript rightly rejects the
        // comparison there as unreachable.
        conditionOutcomes.set(nodeId, branchText)
        tasksCompleted += 1
        messagesCreated += 1
        await updateSharedContext(userId, runId, {
          intermediateResults: { [nodeId]: branchText },
        })
        const outgoing = (graph.edges || []).filter((edge) => edge.source === nodeId)
        if (outgoing.length > 1) {
          const chosen = chooseBranchEdge(outgoing, branch)
          const kept = chosen
            ? collectDownstreamIds(graph.edges || [], [chosen.target])
            : new Set<string>()
          for (const edge of outgoing) {
            if (chosen && edge.target === chosen.target) continue
            for (const id of collectDownstreamIds(graph.edges || [], [edge.target])) {
              if (!kept.has(id)) skippedNodeIds.add(id)
            }
          }
        }
        continue
      }

      // ── Human approval checkpoint (Phase 11) ────────────────────────
      if (resolvedNode.agent?.humanApprovalRequired) {
        // H1: a decided approval for this run is honoured, never re-minted.
        // An approved/edited run proceeds past this checkpoint with no
        // fresh approval; a rejected run fails here; a pending approval
        // elsewhere in the run stays the one the run waits on.
        const runApproval = await latestApprovalForRun(db, userId, runId)
        if (runApproval?.status === 'rejected') {
          return failRunWithReason({
            db,
            userId,
            runId,
            reason: `Approval for this run was rejected${rejectionNote(runApproval.response)}. The rejected output cannot be used, so the run is stopped here.`,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            startedAt,
          })
        }
        if (runApproval?.status === 'pending') {
          // Run is paused waiting for this approval; stop here.
          return {
            runId,
            status: 'paused',
            output: finalOutput,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            durationMs: Date.now() - startedAt,
          }
        }
        // A rejection for this task is terminal: never mint a fresh
        // approval over it and never run past it (C2).
        let taskDecided = false
        if (existingTask?._id) {
          const priorRows = (await db
            .collection('approval_requests')
            .find({
              userId,
              workflowRunId: runId,
              taskId: String(existingTask._id),
            })
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray()) as unknown as Array<Record<string, unknown>>
          const prior = priorRows[0]
          if (prior?.status === 'rejected') {
            return failRunWithReason({
              db,
              userId,
              runId,
              reason: `Approval for the output of "${resolvedNode.node.name}" was rejected${rejectionNote(prior.response)}. The rejected output cannot be used, so the run is stopped here.`,
              tasksCompleted,
              tasksFailed,
              messagesCreated,
              startedAt,
            })
          }
          // approved / edited for this task: it is signed off — the mint
          // guard below must not re-mint over it.
          taskDecided = prior?.status === 'approved' || prior?.status === 'edited'
        }

        // If there's already a pending approval for this task, wait for it.
        const pending = await db
          .collection('approval_requests')
          .findOne({
            userId,
            workflowRunId: runId,
            taskId: existingTask?._id ?? '',
            status: 'pending',
          })

        // Only mint when no decision governs this run or task yet: the
        // run-level check above already returned for a pending or rejected
        // run approval, and an approved/edited decision (run or task level)
        // means this checkpoint must not mint at all.
        const runDecided =
          runApproval?.status === 'approved' || runApproval?.status === 'edited'
        if (!runDecided && !taskDecided && !pending && existingTask?._id) {
          // Create the approval request and pause the run.
          await createApprovalRequest({
            userId,
            workflowRunId: runId,
            taskId: String(existingTask._id),
            requestedByAgentId: resolvedNode.agent._id,
            title: `Approve output from "${resolvedNode.node.name}"`,
            description: resolvedNode.node.description || 'Human approval required before this agent output is used.',
            payload: { nodeId, previousResults },
          })

          await db
            .collection('workflow_runs')
            .updateOne(
              { _id: runResult.insertedId, userId },
              { $set: { status: 'paused', updatedAt: new Date() } },
            )

          return {
            runId,
            status: 'paused',
            output: finalOutput,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            durationMs: Date.now() - startedAt,
          }
        }

        if (pending) {
          // Run is paused waiting for this approval; stop here.
          return {
            runId,
            status: 'paused',
            output: finalOutput,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            durationMs: Date.now() - startedAt,
          }
        }
      }

      // ── Execute the node (returns taskId for retry/recovery) ─────────
      const { taskId, result: nodeResult } = await executeTaskBodyWithId(
        userId,
        runId,
        resolvedNode,
        input,
        previousResults,
        sharedContext,
        effectiveTopK,
        resolved.map((r) => String(r.agent?._id ?? '')),
      )

      previousResults[nodeId] = nodeResult.output
      messagesCreated += nodeResult.messages?.length ?? 0

      if (nodeResult.ok) {
        // ── Critic evaluation (Phase 9) ─────────────────────────────
        // reviewCycle counts for real: each failed evaluation revises the
        // output and re-evaluates it, up to MAX_REVIEW_CYCLES (3) revisions.
        if (critic && nodeResult.output) {
          let acceptedOutput: unknown = nodeResult.output
          let reviewCycle = 0
          let accepted = true
          let lastEvaluation: Awaited<ReturnType<typeof evaluateTaskOutput>> | null = null

          while (true) {
            const evaluation = await evaluateTaskOutput(
              userId,
              runId,
              taskId,
              critic,
              acceptedOutput,
              input,
              reviewCycle,
            )
            messagesCreated += 1
            lastEvaluation = evaluation

            if (evaluation.passed) break

            if (isReviewExhausted(reviewCycle)) {
              // Review cycles exhausted.
              accepted = false
              break
            }

            // Revise based on critic feedback, then re-evaluate the revision.
            const revision = await retryTaskWithFeedback(
              taskId,
              userId,
              runId,
              resolvedNode.agent,
              evaluation.feedback,
              input,
              previousResults,
              DEFAULT_RETRY_POLICY.backoffMs,
            )
            reviewCycle += 1

            if (!revision.ok) {
              accepted = false
              tasksFailed += 1
              finalOutput = {
                error: revision.error,
                failedNode: nodeId,
                evaluation: { passed: false, scores: evaluation.scores },
              }
              break
            }

            acceptedOutput = revision.output
            previousResults[nodeId] = revision.output
            messagesCreated += 1
            await updateSharedContext(userId, runId, {
              intermediateResults: { [nodeId]: revision.output },
            })
          }

          if (!accepted) {
            if (tasksFailed === 0) {
              tasksFailed += 1
              finalOutput = {
                error: 'Review cycles exhausted',
                failedNode: nodeId,
                evaluation: lastEvaluation
                  ? { passed: false, scores: lastEvaluation.scores }
                  : undefined,
              }
            }
            break
          }

          finalOutput = acceptedOutput
          const pausedAfterReview = await pauseForOutputApproval({
            userId,
            runId,
            node: resolvedNode.node,
            agent: resolvedNode.agent,
            taskId,
            previousResults,
            finalOutput,
            tasksCompleted,
            tasksFailed,
            messagesCreated,
            startedAt,
          })
          if (pausedAfterReview) return pausedAfterReview
          tasksCompleted += 1
          await updateSharedContext(userId, runId, {
            intermediateResults: { [nodeId]: acceptedOutput },
          })
          continue
        }

        const paused = await pauseForOutputApproval({
          userId,
          runId,
          node: resolvedNode.node,
          agent: resolvedNode.agent,
          taskId,
          previousResults,
          finalOutput: nodeResult.output,
          tasksCompleted,
          tasksFailed,
          messagesCreated,
          startedAt,
        })
        if (paused) return paused
        tasksCompleted += 1
        await updateSharedContext(userId, runId, {
          intermediateResults: { [nodeId]: nodeResult.output },
        })
        finalOutput = nodeResult.output
      } else {
        // ── Failure recovery (Phase 10) ─────────────────────────────
        // retryCount is read from the stored task row — not rebuilt as 0 —
        // so the maxRetries stop can actually fire.
        const taskRow = await db
          .collection('agent_tasks')
          .findOne({ _id: new ObjectId(taskId), userId, workflowRunId: runId })
        const storedRetryCount =
          typeof taskRow?.retryCount === 'number' ? taskRow.retryCount : 0

        const taskForRecovery: AgentTask = {
          _id: taskId,
          userId,
          workflowRunId: runId,
          agentId: resolvedNode.agent?._id ?? 'system',
          title: resolvedNode.node.name,
          description: resolvedNode.node.description || '',
          input: previousResults,
          status: 'failed',
          dependsOnTaskIds: [],
          retryCount: storedRetryCount,
          maxRetries: resolvedNode.agent?.maxRetryCount ?? 3,
          createdAt: new Date(),
          updatedAt: new Date(),
          error: nodeResult.error,
        }

        // A real fallback agent: the agent's stored fallbackAgentId, else the
        // node's config, else none — and only then can decideRecovery return
        // the fallback action at all.
        const fallbackAgentId =
          resolvedNode.agent?.fallbackAgentId ??
          (typeof resolvedNode.node.config?.fallbackAgentId === 'string'
            ? resolvedNode.node.config.fallbackAgentId
            : undefined)
        const retryPolicy = fallbackAgentId
          ? { ...DEFAULT_RETRY_POLICY, fallbackAgentId }
          : DEFAULT_RETRY_POLICY

        const recovery = decideRecovery(
          taskForRecovery,
          nodeResult.error ?? 'Unknown error',
          retryPolicy,
        )

        if (recovery.action === 'retry' || recovery.action === 'fallback') {
          // Retry the same task (or fallback agent/model).
          let fallbackAgent = resolvedNode.agent
          if (recovery.action === 'fallback' && recovery.fallbackAgentId) {
            try {
              const found = await db.collection('agents').findOne(
                { _id: new ObjectId(recovery.fallbackAgentId), userId },
                { projection: { userApiKey: 0 } },
              )
              if (found) fallbackAgent = found as unknown as Agent
            } catch {
              // An unresolvable fallback id falls back to the same agent.
            }
          }

          const retryResult = await retryTaskWithFeedback(
            taskId,
            userId,
            runId,
            fallbackAgent,
            [nodeResult.error ?? 'Unknown error'],
            input,
            previousResults,
            retryPolicy.backoffMs,
          )

          if (retryResult.ok) {
            previousResults[nodeId] = retryResult.output
            messagesCreated += 1
            await updateSharedContext(userId, runId, {
              intermediateResults: { [nodeId]: retryResult.output },
            })
            finalOutput = retryResult.output
            tasksCompleted += 1
            continue
          } else {
            tasksFailed += 1
            finalOutput = {
              error: retryResult.error,
              failedNode: nodeId,
            }
            break
          }
        } else {
          tasksFailed += 1
          finalOutput = {
            error: recovery.reason ?? nodeResult.error,
            failedNode: nodeId,
          }
          // A failed node stops the sequential chain (per Phase 6 acceptance).
          break
        }
      }
    }
    // Sequential mode: pruned branch nodes never run, so they do not count
    // against the expected completions (mirrors the parallel branch's
    // adjustment above, which uses skippedBranchNodeIds()).
    expectedCompletions = orderedIds.length - tasksSkipped
  }

  // ── 6. Finalise the run ─────────────────────────────────────────────
  // The expected count depends on the mode: supervisor runs count plan
  // tasks, not graph nodes (comparing plan completions against graph nodes
  // reported a fully successful supervisor plan as failed), and nodes
  // skipped by a condition branch do not count in any mode.
  const status =
    (await isCancelled())
      ? 'cancelled'
      : tasksFailed > 0
        ? 'failed'
        : tasksCompleted === expectedCompletions
          ? 'completed'
          : 'failed'
  const durationMs = Date.now() - startedAt

  await db
    .collection('workflow_runs')
    .updateOne(
      { _id: runResult.insertedId, userId },
      {
        $set: {
          status,
          output: finalOutput,
          finishedAt: new Date(),
          durationMs,
        },
      },
    )

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    type: status === 'completed' ? 'run.completed' : 'run.failed',
    payload: { tasksCompleted, tasksFailed, messagesCreated, durationMs, mode },
    createdAt: new Date(),
  })

  return {
    runId,
    status,
    output: finalOutput,
    tasksCompleted,
    tasksFailed,
    messagesCreated,
    durationMs,
  }
}

/**
 * Resume a paused or failed sequential run from its checkpoint.
 *
 * Loads the stored run, checks it belongs to the caller and can be resumed,
 * then re-executes it through `orchestrate` with the existing run id:
 * tasks that already completed in that run are skipped and their outputs
 * reused, remaining tasks run again. Only sequential runs can be resumed —
 * parallel and supervisor runs have no checkpoint to resume from, and
 * resuming them would re-create their tasks.
 */
export async function resumeRun(request: {
  runId: string
  userId: string
}): Promise<OrchestrationResult> {
  const { runId, userId } = request
  const db = await getDb()
  const run = await db.collection('workflow_runs').findOne({
    _id: new ObjectId(runId),
    userId,
  })
  if (!run) throw new Error('Run not found')
  if (run.status === 'completed' || run.status === 'cancelled') {
    throw new Error(`Cannot resume a run in '${run.status}' state`)
  }
  // C2: a run whose approval was rejected must never resume — the rejected
  // output cannot be used, and resuming used to complete the run as if it
  // had been approved. The run is terminal-failed here, with the reason on
  // the run and in the trace, and the caller gets a 409 ('Cannot resume…'
  // is mapped by the runs route). There is no re-request path: rejecting
  // an approval is a final decision on that output.
  const rejected = await rejectedApprovalForRun(db, userId, runId)
  if (rejected) {
    const reason = `Cannot resume: approval "${String(rejected.title ?? 'output approval')}" for this run was rejected${rejectionNote(rejected.response)}. A rejected output cannot be used.`
    await db.collection('workflow_runs').updateOne(
      { _id: new ObjectId(runId), userId },
      { $set: { status: 'failed', output: { error: reason }, finishedAt: new Date() } },
    )
    await db.collection('execution_events').insertOne({
      userId,
      workflowRunId: runId,
      type: 'run.failed',
      payload: {
        reason,
        approvalId: String(rejected._id ?? ''),
        taskId: String(rejected.taskId ?? ''),
      },
      createdAt: new Date(),
    })
    throw new Error(reason)
  }
  const mode = run.mode || 'sequential'
  if (mode !== 'sequential') {
    throw new Error('Cannot resume: only sequential runs can be resumed from a checkpoint')
  }
  const input =
    typeof run.input === 'object' && run.input !== null
      ? String((run.input as Record<string, unknown>).text ?? '')
      : String(run.input ?? '')
  return orchestrate({
    agentId: String(run.agentId),
    input,
    userId,
    mode: 'sequential',
    existingRunId: runId,
  })
}

/**
 * Re-execute one failed task for real (H21).
 *
 * Before this fix, the task-retry endpoint only flipped the task row to
 * `retrying` and nothing ever consumed that status — the row sat
 * `retrying` forever and a resume created a *new* failed task row instead.
 * This helper actually runs the failed node's work again, through the same
 * `runNodeExecution` the orchestrator itself uses (same dispatcher, same
 * input derivation), on the task row itself — no new row, no orphan.
 *
 * The node is found by title: sequential/parallel task rows are created
 * with `title: node.name`, and that is the only node reference a task row
 * carries. The node's input is the optional caller-supplied replacement
 * text, else the last upstream value captured on the task, else the run's
 * original input.
 *
 * After a successful re-execution the run is reconciled: a sequential run
 * with downstream nodes still unrun is resumed from its checkpoint (the
 * retried node is skipped there — it is already completed — and the
 * remaining nodes run); a run whose every task is now completed is marked
 * completed with the retried output. A node that fails again leaves the
 * task `failed` (terminal) and the run `failed`.
 */
export async function reexecuteFailedTask(args: {
  userId: string
  runId: string
  taskId: string
  /** Optional replacement input text for the node (retry with corrected input). */
  input?: string
}): Promise<{
  task: AgentTask | null
  ok: boolean
  error?: string
  resumed?: OrchestrationResult | null
}> {
  const { userId, runId, taskId } = args
  const db = await getDb()
  const run = await db.collection('workflow_runs').findOne({
    _id: new ObjectId(runId),
    userId,
  })
  if (!run) throw new Error('Run not found')
  const task = (await db.collection('agent_tasks').findOne({
    _id: new ObjectId(taskId),
    userId,
    workflowRunId: runId,
  })) as unknown as AgentTask | null
  if (!task) throw new Error('Task not found')
  if (task.status !== 'failed' && task.status !== 'retrying') {
    throw new Error(`Cannot retry a task in '${task.status}' state`)
  }

  const graph = run.workflow as WorkflowGraph | null
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const node = nodes.find((n) => n.name === task.title)
  if (!node) {
    const message = `The workflow no longer contains a node named "${task.title}"`
    await failTask(taskId, userId, runId, message)
    const reloaded = (await db.collection('agent_tasks').findOne({
      _id: new ObjectId(taskId),
      userId,
      workflowRunId: runId,
    })) as unknown as AgentTask | null
    return { task: reloaded, ok: false, error: message }
  }

  let agent: Agent | null = null
  if (run.agentId && ObjectId.isValid(String(run.agentId))) {
    agent = (await db.collection('agents').findOne(
      { _id: new ObjectId(String(run.agentId)), userId },
      { projection: { userApiKey: 0 } },
    )) as unknown as Agent | null
  }

  const previousResults: Record<string, unknown> =
    task.input && typeof task.input === 'object' && !Array.isArray(task.input)
      ? (task.input as Record<string, unknown>)
      : {}
  const originalInput =
    typeof run.input === 'object' && run.input !== null
      ? String((run.input as Record<string, unknown>).text ?? '')
      : String(run.input ?? '')
  const priorValues = Object.values(previousResults).filter(
    (v) => v !== undefined && v !== null,
  )
  // An explicit replacement input must reach the node as its actual input,
  // not just as the run's original text: runNodeExecution derives a code /
  // api / output node's input from the LAST upstream value
  // (latestResult()), so with the captured upstream values still present
  // the override would be ignored and the node would fail exactly as
  // before. Overriding therefore also clears the captured upstream values
  // — the node then falls back to the replacement text as its input.
  const overriding = typeof args.input === 'string'
  const inputText = overriding
    ? (args.input as string)
    : priorValues.length > 0
      ? String(priorValues[priorValues.length - 1])
      : originalInput

  const sharedContext = await getSharedContext(userId, runId)
  // MERGE FIX (I+E): lane I added a required `topK` parameter to
  // runNodeExecution (H18 — one topK source of truth); this retry call
  // site is lane E's and still passed 7 args. Resolve exactly as
  // orchestrate() does, minus the request value (the retry route carries
  // no topK): saved workspace default, else 3. parseTopK clamps 1..50.
  const workspaceSettings = await db.collection('workspace_settings').findOne({ userId })
  const effectiveTopK = parseTopK(workspaceSettings?.defaults?.topK, 3)
  const result = await runNodeExecution(
    taskId,
    userId,
    runId,
    { node, agent },
    inputText,
    overriding ? {} : previousResults,
    sharedContext,
    effectiveTopK,
  )
  const reloaded = (await db.collection('agent_tasks').findOne({
    _id: new ObjectId(taskId),
    userId,
    workflowRunId: runId,
  })) as unknown as AgentTask | null

  if (!result.ok) {
    await db.collection('workflow_runs').updateOne(
      { _id: new ObjectId(runId), userId },
      { $set: { status: 'failed', finishedAt: new Date(), updatedAt: new Date() } },
    )
    await db.collection('execution_events').insertOne({
      userId,
      workflowRunId: runId,
      taskId,
      type: 'task.retry.failed',
      payload: { error: result.error },
      createdAt: new Date(),
    })
    return { task: reloaded, ok: false, error: result.error }
  }

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId: runId,
    taskId,
    type: 'task.retry.succeeded',
    payload: { output: result.output },
    createdAt: new Date(),
  })

  const allTasks = (await db
    .collection('agent_tasks')
    .find({ userId, workflowRunId: runId })
    .toArray()) as unknown as AgentTask[]
  if (allTasks.length > 0 && allTasks.every((t) => t.status === 'completed')) {
    await db.collection('workflow_runs').updateOne(
      { _id: new ObjectId(runId), userId },
      {
        $set: {
          status: 'completed',
          output: result.output,
          finishedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    )
    return { task: reloaded, ok: true, resumed: null }
  }

  // The retried node succeeded but the run is not fully complete — in a
  // sequential run that means downstream nodes never ran (the chain stops
  // at the first failure). Resume from the checkpoint: the retried node is
  // skipped as already completed and the remaining nodes run for real.
  if ((run.mode || 'sequential') === 'sequential') {
    const resumed = await resumeRun({ runId, userId })
    return { task: reloaded, ok: true, resumed }
  }
  return { task: reloaded, ok: true, resumed: null }
}

/**
 * Execute all nodes in parallel with bounded concurrency.
 *
 * All tasks are created up front with their `dependsOnTaskIds` derived from
 * the workflow edges. The scheduler then runs eligible tasks concurrently,
 * respecting the concurrency limit and run-level timeout.
 */
async function executeParallel(
  userId: string,
  workflowRunId: string,
  resolved: ResolvedNode[],
  orderedIds: string[],
  edges: Array<{ source: string; target: string; label?: string }>,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
  budget: {
    maxRunDurationMs: number
    maxMessagesPerRun: number
  },
  getMessageCount: () => Promise<number>,
  isCancelled: () => Promise<boolean>,
  conditionOutcomes: Map<string, 'true' | 'false'>,
  topK: number,
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
}> {
  // ── 5a. Create all tasks up front (in topological order so dependencies
  //      already exist when we wire dependsOnTaskIds) ──────────────────
  const taskIdByNodeId = new Map<string, string>()

  for (const nodeId of orderedIds) {
    const resolvedNode = resolved.find((r) => r.node.id === nodeId)
    if (!resolvedNode) continue

    const { node, agent } = resolvedNode

    // Gather the task IDs of this node's dependencies (incoming edges).
    const dependsOnTaskIds: string[] = []
    for (const edge of edges) {
      if (edge.target === node.id) {
        const depTaskId = taskIdByNodeId.get(edge.source)
        if (depTaskId) dependsOnTaskIds.push(depTaskId)
      }
    }

    const task = await createTask({
      userId,
      workflowRunId,
      agentId: agent?._id ?? 'system',
      title: node.name,
      description: node.description || '',
      input: {},
      dependsOnTaskIds,
      maxRetries: agent?.maxRetryCount ?? 3,
    })

    taskIdByNodeId.set(node.id, String(task._id))
  }

  // ── 5c. Build schedulable tasks ────────────────────────────────────
  const schedulableTasks = resolved.map(({ node, agent }) => {
    const taskId = taskIdByNodeId.get(node.id)!
    // Collect the task IDs this node depends on (from incoming edges).
    const dependsOnTaskIds: string[] = []
    for (const edge of edges) {
      if (edge.target === node.id) {
        const depTaskId = taskIdByNodeId.get(edge.source)
        if (depTaskId) dependsOnTaskIds.push(depTaskId)
      }
    }

    return {
      id: taskId,
      dependsOnTaskIds,
      execute: async () => {
        // Branch check: if an incoming edge comes from a Condition node,
        // this node runs only when that edge is the one the shared
        // branch-selection rule picks for the recorded outcome
        // (`chooseBranchEdge` in branching.ts — the same rule execute and
        // orchestrate-sequential use). Unlabeled edges are decided by the
        // rule too (first edge true / last edge false), so a FALSE outcome
        // never runs both branches. Otherwise this node is skipped — not
        // failed. The scheduler counts it as cancelled, and its own
        // dependents are then cancelled too.
        for (const edge of edges) {
          if (edge.target !== node.id) continue
          const outcome = conditionOutcomes.get(edge.source)
          if (!outcome) continue
          const outgoing = edges.filter((e) => e.source === edge.source)
          const chosen = chooseBranchEdge(outgoing, outcome === 'true')
          if (!chosen || chosen.target !== edge.target) {
            return {
              nodeId: node.id,
              ok: false,
              skipped: true,
              error: 'skipped',
              durationMs: 0,
            }
          }
        }
        // Re-read shared context at execution time: upstream tasks have
        // written their outputs there, so a dependent task sees real results
        // instead of the empty snapshot from before the run started.
        const freshShared = await getSharedContext(userId, workflowRunId)
        const upstream: Record<string, unknown> = {
          ...previousResults,
          ...(freshShared.intermediateResults ?? {}),
        }
        const result = await runNodeExecution(
          taskId,
          userId,
          workflowRunId,
          { node, agent },
          originalInput,
          upstream,
          sharedContext,
          topK,
          resolved.map((r) => String(r.agent?._id ?? '')),
        )
        if (result.ok) {
          previousResults[node.id] = result.output
          if (node.type === 'condition') {
            conditionOutcomes.set(node.id, result.output === 'true' ? 'true' : 'false')
          }
        }
        return result
      },
    }
  })

  // ── 5d. Run through bounded-concurrency scheduler ──────────────────
  const schedule = await scheduleParallel(schedulableTasks, {
    ...DEFAULT_SCHEDULER_CONFIG,
    maxRunDurationMs: budget.maxRunDurationMs,
    maxMessagesPerRun: budget.maxMessagesPerRun,
    getMessageCount,
    isCancelled,
  })

  // ── 5e. Collect results into previousResults ───────────────────────
  let messagesCreated = 0
  let finalOutput: unknown = null

  // Tasks the scheduler cancelled never ran: branch-skipped nodes and
  // their dependency-blocked downstream nodes (C3 — the unchosen branch
  // of a Condition), plus timeout / user-cancel leftovers. They are not
  // failures and must not clobber the run output: without this, the
  // last node in resolved order (e.g. the unchosen branch's output
  // node) overwrites finalOutput with its `dependency_failed` error
  // whenever the FIRST branch is taken, so parallel disagrees with
  // execute / orchestrate-sequential on the very same graph.
  const cancelledTaskIds = new Set(schedule.cancelled)

  for (const { node } of resolved) {
    const taskId = taskIdByNodeId.get(node.id)!
    const result = schedule.results.get(taskId)
    if (!result) continue

    messagesCreated += result.messages?.length ?? 0
    previousResults[node.id] = result.output

    if (result.ok) {
      finalOutput = result.output
    } else if (!cancelledTaskIds.has(taskId)) {
      finalOutput = { error: result.error, failedNode: node.id }
    }
  }

  return {
    completed: schedule.completed,
    // Cancelled tasks did not run, so they are not failures: the caller
    // already excludes branch-skipped nodes from the expected-completion
    // count, and the run status must agree (a branched parallel run
    // with no genuine failure is 'completed'). Genuine failures land
    // in schedule.failed. Timeout / user-cancel still degrade the
    // status via the completions check and isCancelled() in the caller.
    failed: schedule.failed,
    messagesCreated,
    finalOutput,
  }
}

/**
 * Supervisor mode: generate a plan from the natural-language request,
 * validate it, then execute the tasks via the bounded-concurrency scheduler.
 */
async function executeSupervisorMode(
  userId: string,
  workflowRunId: string,
  agent: Agent,
  input: string,
  getMessageCount: () => Promise<number>,
  isCancelled: () => Promise<boolean>,
  conversational?: boolean,
): Promise<{
  completed: number
  failed: number
  messagesCreated: number
  finalOutput: unknown
  /** Plan task count — the expected-completion denominator for this mode. */
  total: number
}> {
  // ── List available agents for plan selection ───────────────────────
  const agentSummaries = await listAvailableAgents(userId)

  // ── Generate the plan ──────────────────────────────────────────────
  const plan = await generateSupervisorPlan(userId, input, agentSummaries, {
    conversational,
  })

  // ── Validate the plan ──────────────────────────────────────────────
  const validation = validateSupervisorPlan(plan, agentSummaries)
  if (!validation.valid) {
    throw new Error(`Supervisor plan invalid: ${validation.errors.join('; ')}`)
  }

  // ── Load full agent documents (needed for execution) ───────────────
  const db = await getDb()
  const agents = await db
    .collection('agents')
    .find({ userId }, { projection: { userApiKey: 0 } })
    .toArray() as unknown as Agent[]

  // ── Execute the plan ───────────────────────────────────────────────
  const result = await executeSupervisorPlan(
    userId,
    workflowRunId,
    plan,
    agents,
    { originalInput: input, getMessageCount, isCancelled, conversational },
  )

  // ── Persist the plan and objective to shared context ───────────────
  await updateSharedContext(userId, workflowRunId, {
    variables: {
      supervisorObjective: plan.objective,
      supervisorCompletionCriteria: plan.completionCriteria,
    },
  })

  return { ...result, total: plan.tasks.length }
}

/**
 * Create a task record for a node and execute it as an agent turn.
 *
 * Used by sequential mode. Creates the task, then delegates to
 * `runNodeExecution` for the actual agent turn.
 */
/**
 * Create a task record for a node and execute it as an agent turn.
 *
 * Returns both the task id (for retry/recovery) and the execution result.
 * Used by sequential mode.
 */
async function executeTaskBodyWithId(
  userId: string,
  workflowRunId: string,
  { node, agent }: ResolvedNode,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
  topK: number,
  teamAgentIds: Array<string | undefined | null> = [],
): Promise<{ taskId: string; result: NodeExecutionResult }> {
  const task = await createTask({
    userId,
    workflowRunId,
    agentId: agent?._id ?? 'system',
    title: node.name,
    description: node.description || '',
    input: previousResults,
    dependsOnTaskIds: [],
    maxRetries: agent?.maxRetryCount ?? 3,
  })

  const taskId = String(task._id)
  const result = await runNodeExecution(
    taskId,
    userId,
    workflowRunId,
    { node, agent },
    originalInput,
    previousResults,
    sharedContext,
    topK,
    teamAgentIds,
  )

  return { taskId, result }
}

/**
 * Run a single node's agent turn against an already-created task.
 *
 * Sets task to running → runs the node through the ONE shared dispatcher
 * (src/lib/workflow/nodeRunner.ts — the same code the single-agent executor
 * calls, so node types behave identically in both paths) → writes shared
 * context → emits result message → completes/fails task.
 *
 * What text the node works on depends on its type: an LLM node gets the full
 * prompt (original request + upstream results + shared context); a RAG node
 * gets the original request as its query; API/Condition/Output nodes get the
 * latest upstream result (or the original request when there is none); a
 * Trigger node gets the original request.
 */
async function runNodeExecution(
  taskId: string,
  userId: string,
  workflowRunId: string,
  { node, agent }: ResolvedNode,
  originalInput: string,
  previousResults: Record<string, unknown>,
  sharedContext: AgentExecutionContext['sharedContext'],
  topK: number,
  teamAgentIds: Array<string | undefined | null> = [],
): Promise<NodeExecutionResult> {
  await updateTaskStatus(taskId, userId, workflowRunId, {
    status: 'running',
    startedAt: true,
  })

  const start = Date.now()

  // A Condition node branches on the shared comparator — it never calls an
  // LLM. Its output is the literal text "true" or "false". (Branch pruning
  // happens in sequential mode; parallel mode evaluates the condition and
  // records the branch, but tasks on both branches were already created.)
  if (node.type === 'condition') {
    const priorValues = Object.values(previousResults)
    const last = priorValues.length ? priorValues[priorValues.length - 1] : undefined
    const stateText =
      last == null ? originalInput : typeof last === 'string' ? last : (JSON.stringify(last) ?? originalInput)
    try {
      const branch = evaluateCondition(node.config, stateText)
      const branchText = branch ? 'true' : 'false'
      await completeTask(taskId, userId, workflowRunId, branchText)
      await createMessage({
        userId,
        workflowId: workflowRunId,
        workflowRunId,
        fromAgentId: agent?._id ?? 'system',
        toAgentId: undefined,
        taskId,
        type: 'result',
        text: `Condition evaluated to ${branch}.`,
        payload: { nodeId: node.id, branch: branchText },
      })
      return {
        nodeId: node.id,
        ok: true,
        output: branchText,
        durationMs: Date.now() - start,
        provider: null,
        model: null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid condition.'
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

  try {
    // Team runs only: fetch the blackboard (whole conversation + shared
    // context) for this agent's turn. Single-agent runs are a no-op
    // inside getTeamTurnContext (no DB read, empty text), so their
    // prompts stay byte-identical.
    const teamContext = await getTeamTurnContext(userId, workflowRunId, teamAgentIds)
    const latestResult = (): string => {
      const values = Object.values(previousResults).filter((v) => v !== undefined && v !== null)
      return values.length > 0 ? String(values[values.length - 1]) : originalInput
    }
    const input =
      node.type === 'llm'
        ? buildUserPrompt({ originalInput, previousResults, sharedContext, node, blackboardText: teamContext.blackboardText })
        : node.type === 'rag'
          ? originalInput
          : node.type === 'trigger'
            ? originalInput
            : latestResult()

    // H18: the run's resolved topK (request value, else saved workspace
    // default, else 3) — never a hardcoded 3. A rag node's own config
    // topK still wins inside runRagNode, exactly as on /api/execute.
    const nodeResult = await runWorkflowNode({
      node,
      agent,
      userId,
      input,
      originalInput,
      topK,
      // The orchestrator owns this run id — pass it so an 'ask' node can
      // record its question + reply instead of failing honestly.
      workflowRunId,
    })

    if (!nodeResult.ok) {
      const error = nodeResult.error ?? nodeResult.summary
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

    const output = nodeResult.state

    // Write result into shared context and emit a result message.
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
      payload: { nodeId: node.id, provider: nodeResult.provider, model: nodeResult.model },
    })

    await completeTask(taskId, userId, workflowRunId, output)

    return {
      nodeId: node.id,
      ok: true,
      output,
      durationMs: Date.now() - start,
      provider: nodeResult.provider,
      model: nodeResult.model,
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

/**
 * Map each workflow node to its agent (via config.agentId or the owner agent).
 *
 * Loads every agent a node config names and checks it belongs to the caller.
 * A reference to an agent that does not exist or is not yours throws an
 * honest error — it never silently falls back to the owner agent.
 */
async function resolveNodes(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
  nodes: WorkflowNode[],
  ownerAgent: Agent,
): Promise<ResolvedNode[]> {
  const ids = referencedAgentIds(nodes)
  const agentsById = new Map<string, Agent>()
  if (ids.length > 0) {
    const validIds = ids.filter((id) => ObjectId.isValid(id))
    if (validIds.length > 0) {
      const found = (await db
        .collection('agents')
        .find(
          { _id: { $in: validIds.map((id) => new ObjectId(id)) }, userId },
          { projection: { userApiKey: 0 } },
        )
        .toArray()) as unknown as Agent[]
      for (const agent of found) agentsById.set(String(agent._id), agent)
    }
  }
  return resolveNodeAgents(nodes, ownerAgent, agentsById)
}

/** Build the user prompt from the execution context (Phase 6 input shape). */
function buildUserPrompt(ctx: {
  originalInput: string
  previousResults: Record<string, unknown>
  sharedContext: AgentExecutionContext['sharedContext']
  node: WorkflowNode
  /** Rendered team blackboard; absent/empty for single-agent runs. */
  blackboardText?: string
}): string {
  const parts: string[] = []

  parts.push(`Original request: ${ctx.originalInput}`)

  if (ctx.sharedContext.variables && Object.keys(ctx.sharedContext.variables).length > 0) {
    parts.push(`\nContext variables:\n${JSON.stringify(ctx.sharedContext.variables, null, 2)}`)
  }

  const prior = Object.entries(ctx.previousResults)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([nodeId, output]) => `Result from "${nodeId}":\n${String(output)}`)
  if (prior.length > 0) {
    parts.push(`\nPrevious results:\n${prior.join('\n\n---\n\n')}`)
  }

  if (ctx.sharedContext.intermediateResults && Object.keys(ctx.sharedContext.intermediateResults).length > 0) {
    parts.push(`\nIntermediate results:\n${JSON.stringify(ctx.sharedContext.intermediateResults, null, 2)}`)
  }

  // Team runs only: the shared blackboard (whole conversation + shared
  // context), rendered by getTeamTurnContext. Empty for single-agent runs,
  // so their prompts are byte-identical to before.
  if (ctx.blackboardText) {
    parts.push(`\n${ctx.blackboardText}`)
  }

  parts.push(`\nCurrent node: "${ctx.node.name}" (${ctx.node.type})`)
  parts.push(`Description: ${ctx.node.description || '(none)'}`)

  return parts.join('\n')
}
