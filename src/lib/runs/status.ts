/**
 * Map a stored run status to what the dashboard shows. Only an explicit
 * success/completed counts as a success: a run that is still running,
 * paused, or queued is in progress, and a cancelled run is cancelled.
 * The old mapping (`status === 'failed' ? 'failed' : 'success'`) counted
 * every non-failed row — including stuck `running` rows — as a success.
 */
export type DisplayRunStatus = 'success' | 'failed' | 'in-progress' | 'cancelled'

export function mapRunStatus(status: unknown): DisplayRunStatus {
  if (status === 'failed') return 'failed'
  if (status === 'success' || status === 'completed') return 'success'
  if (status === 'cancelled') return 'cancelled'
  return 'in-progress'
}
