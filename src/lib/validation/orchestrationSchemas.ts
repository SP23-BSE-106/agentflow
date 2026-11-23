/**
 * Zod validation schemas for orchestration requests (Milestone 7).
 *
 * Provides runtime validation for API request bodies, complementing
 * TypeScript's compile-time type checking.
 */

import { z } from 'zod'

export const orchestrationRequestSchema = z.object({
  agentId: z.string().min(1, 'agentId is required').max(64),
  input: z.string().min(1, 'input is required').max(8000, 'input must be at most 8000 characters'),
  mode: z.enum(['sequential', 'parallel', 'supervisor', 'team']).optional(),
  conversational: z.boolean().optional(),
  // H18: retrieval breadth for RAG nodes — same 1..50 rule as parseTopK
  // on every other path. Explicit value wins; absent means the saved
  // workspace default (resolved in orchestrate()).
  topK: z.number().int().min(1).max(50).optional(),
})

export type OrchestrationRequestInput = z.infer<
  typeof orchestrationRequestSchema
>

/** Schema for validating a supervisor-generated execution plan. */
export const supervisorPlanSchema = z.object({
  objective: z.string().min(1, 'objective is required').max(8000, 'objective must be at most 8000 characters'),
  tasks: z
    .array(
      z.object({
        temporaryId: z.string().min(1),
        agentId: z.string().min(1),
        description: z.string().min(1),
        dependsOn: z.array(z.string()).default([]),
        expectedOutput: z.string().min(1),
      }),
    )
    .min(1, 'at least one task is required')
    .max(10, 'maximum 10 tasks allowed'),
  completionCriteria: z.array(z.string()).default([]),
})

export type SupervisorPlanInput = z.infer<typeof supervisorPlanSchema>
