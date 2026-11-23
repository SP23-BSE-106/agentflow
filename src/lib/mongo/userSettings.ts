export type UserSettings = {
  _id?: string
  userId: string
  preferences?: {
    /** Example: marketing emails toggle */
    marketingEmails?: boolean
    /** UI density: 'comfortable' | 'compact' */
    density?: 'comfortable' | 'compact'
    [key: string]: unknown
  }
  /** Permission flags. Missing flags default to denied (see checkPermission). */
  permissions?: {
    canExecute?: boolean
    canEditWorkflows?: boolean
    canCreateAgents?: boolean
    canViewAnalytics?: boolean
  }
  /** Execution budgets for production hardening. */
  executionBudget?: {
    /** Maximum runs per hour per user. */
    maxRunsPerHour?: number
    /** Maximum execution duration in ms per run. */
    maxRunDurationMs?: number
    /** Maximum number of tasks per run. */
    maxTasksPerRun?: number
    /** Maximum number of messages per run. */
    maxMessagesPerRun?: number
  }
  createdAt: Date
  updatedAt?: Date
}
