/**
 * Critic / fact-checker evaluation (implementation plan Phase 9 + Phase 10).
 *
 * Provides output quality evaluation (accuracy, relevance, completeness,
 * groundedness) and failure recovery with retry/fallback policies.
 *
 * Modules it composes:
 *   - taskManager      — task lifecycle + retry counting
 *   - messageBus       — structured agent-to-agent feedback messages
 *   - contextManager   — shared run context (decisions, intermediate results)
 *   - messageBus / evaluation — persistence via the runs API
 */

import { chatCompletion } from '@/lib/llm'
import { getDb } from '@/lib/mongo/mongo'
import { ObjectId } from 'mongodb'

import { failTask } from './taskManager'
import { createMessage } from './messageBus'
import { addDecision } from './contextManager'
import type { AgentTask } from '@/lib/mongo/agentTasks'
import type { Agent } from '@/lib/mongo/agent'

/* ───────────────────────── types ───────────────────────── */

/** Scores produced by a critic evaluation. */
export type EvaluationScores = {
  accuracy: number
  relevance: number
  completeness: number
  groundedness: number
}

/** Result of evaluating one task's output. */
export type EvaluationResult = {
  taskId: string
  passed: boolean
  overallScore: number
  scores: EvaluationScores
  feedback: string[]
  /** Number of review cycles already applied to this task. */
  reviewCycle: number
}

/** Retry policy for a task. */
export type RetryPolicy = {
  maxRetries: number
  backoffMs: number
  retryableErrors: string[]
  fallbackAgentId?: string
  fallbackModel?: string
}

/** Default retry policy. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: 1_000,
  retryableErrors: [
    'No inference provider answered',
    'Provider rejected the request',
    'timeout',
    'ECONNREFUSED',
    'ETIMEDOUT',
  ],
  fallbackModel: undefined,
  fallbackAgentId: undefined,
}

/** Hard cap on review cycles to prevent infinite debates (Phase 9). */
const MAX_REVIEW_CYCLES = 3

/** Threshold below which an evaluation fails and triggers revision. */
const EVALUATION_PASS_THRESHOLD = 0.7

/* ───────────────────────── evaluation ───────────────────────── */

/**
 * Evaluate a task's output using a critic/fact-checker agent.
 *
 * Scores accuracy, relevance, completeness, and groundedness on a 0-1 scale.
 * If overallScore >= EVALUATION_PASS_THRESHOLD the output passes.
 */
export async function evaluateTaskOutput(
  userId: string,
  workflowRunId: string,
  targetTaskId: string,
  evaluatorAgent: Agent | null,
  output: unknown,
  originalInput: string,
  reviewCycle: number,
): Promise<EvaluationResult> {
  const db = await getDb()

  const system = buildEvaluationSystemPrompt(evaluatorAgent)
  const prompt = buildEvaluationPrompt(originalInput, output)

  const completion = await chatCompletion({
    system,
    prompt,
    maxTokens: 1024,
    temperature: 0.2,
    timeoutMs: 30_000,
  })

  if (!completion.ok) {
    const error = `No inference provider answered: ${completion.failures?.map((f) => f.message).join('; ') || 'unknown'}`
    // Record a failed evaluation event so the run trace shows what happened.
    await db.collection('execution_events').insertOne({
      userId,
      workflowRunId,
      agentId: evaluatorAgent ? String(evaluatorAgent._id) : 'system',
      taskId: targetTaskId,
      type: 'evaluation.created',
      payload: { error, overallScore: 0, passed: false },
      createdAt: new Date(),
    })
    return {
      taskId: targetTaskId,
      passed: false,
      overallScore: 0,
      scores: { accuracy: 0, relevance: 0, completeness: 0, groundedness: 0 },
      feedback: [error],
      reviewCycle,
    }
  }

  const parsed = parseEvaluation(completion.text)
  const overallScore =
    (parsed.accuracy + parsed.relevance + parsed.completeness + parsed.groundedness) /
    4
  const passed = overallScore >= EVALUATION_PASS_THRESHOLD

  const evaluation = {
    userId,
    workflowRunId,
    targetTaskId,
    evaluatorAgentId: evaluatorAgent ? String(evaluatorAgent._id) : 'system',
    scores: parsed,
    overallScore,
    passed,
    feedback: parsed.feedback,
    reviewCycle,
    createdAt: new Date(),
  }

  const result = await db.collection('agent_evaluations').insertOne(evaluation)

  await db.collection('execution_events').insertOne({
    userId,
    workflowRunId,
    agentId: evaluatorAgent ? String(evaluatorAgent._id) : 'system',
    taskId: targetTaskId,
    messageId: String(result.insertedId),
    type: 'evaluation.created',
    payload: { overallScore, passed, feedback: parsed.feedback },
    createdAt: new Date(),
  })

  // Record the critic's decision in shared context.
  await addDecision(
    userId,
    workflowRunId,
    evaluatorAgent?._id ?? 'system',
    passed ? 'output_approved' : 'output_needs_revision',
    parsed.feedback.join('; '),
  )

  return {
    taskId: targetTaskId,
    passed,
    overallScore,
    scores: parsed,
    feedback: parsed.feedback,
    reviewCycle,
  }
}

/** Build the critic system prompt. */
function buildEvaluationSystemPrompt(evaluatorAgent: Agent | null): string {
  const base =
    'You are a critic / fact-checker agent in the AgentFlow multi-agent platform.\n' +
    'Your job is to evaluate another agent\u2019s output and score it on four criteria,\n' +
    'each from 0 to 1:\n' +
    '  - accuracy:    Is the information factually correct?\n' +
    '  - relevance:   Does it answer the user\u2019s actual request?\n' +
    '  - completeness: Does it cover all parts of the request?\n' +
    '  - groundedness: Are claims supported by provided context / sources?\n\n' +
    'Return ONLY valid JSON matching this schema:\n' +
    '{\n' +
    '  "accuracy": number (0-1),\n' +
    '  "relevance": number (0-1),\n' +
    '  "completeness": number (0-1),\n' +
    '  "groundedness": number (0-1),\n' +
    '  "feedback": ["string", ...]  // specific, actionable issues to fix\n' +
    '}\n' +
    'No markdown fences, no extra text.'

  if (evaluatorAgent?.systemPrompt && evaluatorAgent.systemPrompt.trim()) {
    return `${evaluatorAgent.systemPrompt.trim()}\n\n${base}`
  }
  return base
}

/** Build the evaluation user prompt. */
function buildEvaluationPrompt(originalInput: string, output: unknown): string {
  return `Original request:\n${originalInput}\n\nOutput to evaluate:\n${JSON.stringify(output, null, 2)}\n\nScore the output and list specific feedback.`
}

/** Parse evaluation JSON from LLM output, with safe defaults. */
function parseEvaluation(text: string): EvaluationScores & { feedback: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      return {
        accuracy: 0,
        relevance: 0,
        completeness: 0,
        groundedness: 0,
        feedback: ['Could not parse evaluation output.'],
      }
    }
    try {
      raw = JSON.parse(match[0])
    } catch {
      return {
        accuracy: 0,
        relevance: 0,
        completeness: 0,
        groundedness: 0,
        feedback: ['Could not parse evaluation output.'],
      }
    }
  }

  const obj = raw as Record<string, unknown>
  const clamp = (value: unknown): number => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
  }

  return {
    accuracy: clamp(obj.accuracy),
    relevance: clamp(obj.relevance),
    completeness: clamp(obj.completeness),
    groundedness: clamp(obj.groundedness),
    feedback: Array.isArray(obj.feedback)
      ? obj.feedback.map((f) => String(f)).slice(0, 10)
      : [String(obj.feedback || '')],
  }
}

/* ───────────────────────── recovery ───────────────────────── */

/**
 * Determine whether a task should be retried, reassigned to a fallback,
 * or stopped, based on its error and retry policy.
 *
 * Returns:
 *   - { action: 'retry', policy } — retry the same task
 *   - { action: 'fallback', policy, fallbackAgentId } — retry with fallback agent/model
 *   - { action: 'stop', reason } — do not retry; surface the failure
 */
export function decideRecovery(
  task: AgentTask,
  error: string,
  policy: RetryPolicy,
): {
  action: 'retry' | 'fallback' | 'stop'
  policy: RetryPolicy
  fallbackAgentId?: string
  fallbackModel?: string
  reason?: string
} {
  const alreadyRetried = task.retryCount || 0

  // Hard limit: never retry past maxRetries.
  if (alreadyRetried >= task.maxRetries) {
    return {
      action: 'stop',
      policy,
      reason: `Maximum retry count (${task.maxRetries}) exceeded.`,
    }
  }

  // Is this error retryable?
  const isRetryable = policy.retryableErrors.some((pattern) =>
    error.toLowerCase().includes(pattern.toLowerCase()),
  )

  if (!isRetryable) {
    return {
      action: 'stop',
      policy,
      reason: `Non-retryable error: ${error}`,
    }
  }

  // If a fallback agent/model is configured, prefer reassignment.
  if (policy.fallbackAgentId || policy.fallbackModel) {
    return {
      action: 'fallback',
      policy,
      fallbackAgentId: policy.fallbackAgentId,
      fallbackModel: policy.fallbackModel,
    }
  }

  return { action: 'retry', policy }
}

/**
 * Apply a backoff delay before a retry.
 */
export async function waitForBackoff(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Check whether a task has exhausted its review cycles and should stop
 * being revised (Phase 9: hard maximum of 2-3 review cycles).
 */
export function isReviewExhausted(reviewCycle: number): boolean {
  return reviewCycle >= MAX_REVIEW_CYCLES
}

/* ───────────────────────── retry with revision ───────────────────────── */

/**
 * Retry a failed task: increment retry count, emit a feedback message, and
 * re-execute the task with the critic's feedback included in the prompt.
 *
 * Returns the new task execution result.
 */
export async function retryTaskWithFeedback(
  taskId: string,
  userId: string,
  workflowRunId: string,
  agent: Agent | null,
  feedback: string[],
  originalInput: string,
  previousResults: Record<string, unknown>,
  backoffMs: number = DEFAULT_RETRY_POLICY.backoffMs,
): Promise<{
  ok: boolean
  output?: unknown
  error?: string
  durationMs: number
}> {
  const db = await getDb()
  const start = Date.now()

  // The backoff is waited here, on every retry path, so a retry never fires
  // immediately after the failure that caused it.
  if (backoffMs > 0) await waitForBackoff(backoffMs)

  // Increment retry count on the task.
  const updated = await db
    .collection('agent_tasks')
    .findOneAndUpdate(
      { _id: new ObjectId(taskId), userId, workflowRunId },
      {
        $inc: { retryCount: 1 },
        $set: { status: 'retrying', updatedAt: new Date() },
      },
      { returnDocument: 'after' },
    )

  const retryCount = (updated as unknown as { retryCount?: number })?.retryCount ?? 0

  // Emit a feedback message so the trace shows why we're retrying.
  await createMessage({
    userId,
    workflowId: workflowRunId,
    workflowRunId,
    fromAgentId: agent?._id ?? 'system',
    toAgentId: agent?._id ?? undefined,
    taskId,
    type: 'feedback',
    text: feedback.join('; '),
    payload: { retryCount, feedback },
    priority: 'high',
  })

  // Build a revision prompt that includes the critic feedback.
  const system = buildRevisionSystemPrompt(agent, feedback)
  const prompt = buildRevisionPrompt(originalInput, previousResults)

  const completion = await chatCompletion({
    system,
    prompt,
    maxTokens: agent?.maxTokenBudget ?? 2048,
    temperature: 0.4,
    timeoutMs: 30_000,
  })

  if (!completion.ok) {
    const error = `No inference provider answered: ${completion.failures?.map((f) => f.message).join('; ') || 'unknown'}`
    await failTask(taskId, userId, workflowRunId, error)
    return { ok: false, error, durationMs: Date.now() - start }
  }

  const output = completion.text

  await db
    .collection('agent_tasks')
    .updateOne(
      { _id: new ObjectId(taskId), userId, workflowRunId },
      {
        $set: {
          status: 'completed',
          output,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    )

  await createMessage({
    userId,
    workflowId: workflowRunId,
    workflowRunId,
    fromAgentId: agent?._id ?? 'system',
    toAgentId: undefined,
    taskId,
    type: 'result',
    text: output,
    payload: { nodeId: taskId, provider: completion.provider, model: completion.model, retried: true },
  })

  await addDecision(
    userId,
    workflowRunId,
    agent?._id ?? 'system',
    'output_revised',
    `Revised after retry #${retryCount}.`,
  )

  return {
    ok: true,
    output,
    durationMs: Date.now() - start,
  }
}

/** System prompt for a revision attempt. */
function buildRevisionSystemPrompt(agent: Agent | null, feedback: string[]): string {
  const base =
    'You are revising your previous output based on critic feedback.\n' +
    'Address every point in the feedback and produce an improved result.\n' +
    'Return only the revised output, no explanations.\n'

  const agentPrompt = agent?.systemPrompt && agent.systemPrompt.trim()
    ? `Agent instructions: ${agent.systemPrompt.trim()}\n\n`
    : ''

  const feedbackList = feedback.map((f) => `- ${f}`).join('\n')

  return `${agentPrompt}${base}Critic feedback to address:\n${feedbackList}`
}

/** User prompt for a revision attempt. */
function buildRevisionPrompt(
  originalInput: string,
  previousResults: Record<string, unknown>,
): string {
  const prior = Object.entries(previousResults)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([nodeId, output]) => `Result from "${nodeId}":\n${String(output)}`)
    .join('\n\n---\n\n')

  return `Original request:\n${originalInput}\n\nPrevious results:\n${prior || '(none)'}\n\nProduce the revised output addressing the feedback above.`
}
