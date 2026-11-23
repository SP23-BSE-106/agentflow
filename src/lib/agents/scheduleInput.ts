/**
 * Schedule input validation (H23).
 *
 * One shared validator for every product path that writes `agent.schedule`
 * (agent create, agent PATCH). The trigger checker (`checkRoute.ts`) reads
 * `schedule.cron` / `schedule.timezone` / `schedule.lastFiredAt` off the
 * agent doc; clients may only set `cron` and `timezone` — `lastFiredAt`
 * is stamped by the checker and is refused here so a caller cannot fake
 * a "just fired" stamp and suppress the next due fire.
 */
import { validateCron } from '@/lib/triggers/schedule'

export type ValidSchedule = { cron: string; timezone?: string }

export function validateScheduleInput(
  value: unknown,
): { ok: true; schedule: ValidSchedule | null } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, schedule: null }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'schedule must be an object like {"cron": "* * * * *"} or null to clear it.' }
  }
  const raw = value as Record<string, unknown>
  if ('lastFiredAt' in raw) {
    return { ok: false, error: 'schedule.lastFiredAt is managed by the trigger checker and cannot be set.' }
  }
  if (typeof raw.cron !== 'string' || !raw.cron.trim()) {
    return { ok: false, error: 'schedule.cron is required and must be a cron expression like "* * * * *".' }
  }
  const checked = validateCron(raw.cron.trim())
  if (!checked.ok) {
    return { ok: false, error: `schedule.cron is not a valid cron expression: ${checked.error}` }
  }
  if (raw.timezone !== undefined && (typeof raw.timezone !== 'string' || !raw.timezone.trim())) {
    return { ok: false, error: 'schedule.timezone, when given, must be an IANA timezone name like "Asia/Karachi".' }
  }
  return {
    ok: true,
    schedule: {
      cron: raw.cron.trim(),
      ...(typeof raw.timezone === 'string' && raw.timezone.trim()
        ? { timezone: raw.timezone.trim() }
        : {}),
    },
  }
}
