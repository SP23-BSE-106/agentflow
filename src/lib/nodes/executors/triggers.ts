/**
 * Entry-node executors: Webhook, Manual Trigger, Schedule Trigger,
 * Form Trigger, Error Trigger.
 *
 * These nodes start a run — they pass the items they were started with
 * through unchanged. (Webhook registration, schedule firing, and the
 * hosted form live in Lane G's trigger modules; the item executor only
 * needs the pass-through behaviour here.) A run started with no items
 * seeds one empty item so downstream nodes have something to work on;
 * the item executor does that seeding, this module just passes through.
 */

import type { NodeExecutor } from './context'

export const executeTriggerNode: NodeExecutor = async ({ items }) => ({ items })

export const executeWebhookNode: NodeExecutor = async ({ items }) => ({ items })

export const executeManualNode: NodeExecutor = async ({ items }) => ({ items })

export const executeScheduleNode: NodeExecutor = async ({ items }) => ({ items })

export const executeFormTriggerNode: NodeExecutor = async ({ items }) => ({ items })

export const executeErrorTriggerNode: NodeExecutor = async ({ items }) => ({ items })
