// TypeScript types for the agent_evaluations collection.
// Scores and feedback produced by critic / fact-checker agents reviewing a
// worker agent's output.

export type AgentEvaluation = {
  _id?: string
  userId: string
  workflowRunId: string
  targetTaskId: string
  evaluatorAgentId: string
  scores: {
    accuracy: number
    relevance: number
    completeness: number
    groundedness: number
  }
  overallScore: number
  passed: boolean
  feedback: string[]
  createdAt: Date
}
