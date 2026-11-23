/**
 * Wait node — pauses the run. The executor itself does the pausing; this
 * module only works out *when* to resume from the node config.
 *
 * Config (one of):
 *   amount + unit: number of seconds/minutes/hours/days to wait
 *     (default: 60 seconds when nothing is given)
 *   resumeAt: ISO date string to resume at
 *   resumeKind: 'time' (default) | 'webhook' | 'form' — webhook/form waits
 *     resume through the same resume endpoint when the external event
 *     arrives; a time wait also carries a `resumeAt` so the sweep can
 *     resume it.
 */

import type { NodeExecutor } from './context'

const UNIT_MS: Record<string, number> = {
  seconds: 1000,
  second: 1000,
  minutes: 60_000,
  minute: 60_000,
  hours: 3_600_000,
  hour: 3_600_000,
  days: 86_400_000,
  day: 86_400_000,
}

export const executeWaitNode: NodeExecutor = async ({ config }) => {
  const resumeKind =
    config.resumeKind === 'webhook' || config.resumeKind === 'form' ? config.resumeKind : 'time'
  let resumeAt: Date
  if (typeof config.resumeAt === 'string' && config.resumeAt.trim()) {
    resumeAt = new Date(config.resumeAt)
    if (Number.isNaN(resumeAt.getTime())) {
      throw new Error('Wait node: config.resumeAt is not a valid date.')
    }
  } else {
    const amount = Number(config.amount)
    const unit = typeof config.unit === 'string' ? config.unit.toLowerCase() : 'seconds'
    const ms = (Number.isFinite(amount) && amount > 0 ? amount : 60) * (UNIT_MS[unit] ?? 1000)
    resumeAt = new Date(Date.now() + ms)
  }
  return { items: [], wait: { resumeAt, resumeKind } }
}
