# Multi-Agent Database Indexes (Migration Notes)

These indexes support the new collections introduced in Milestone 1
(communication foundation). They can be created on first run via the existing
`/api/dev/init-collections` endpoint (guarded by `x-dev-secret`) or added to a
schema-migration script before deploying.

## New collections

- `agent_tasks`
- `agent_messages`
- `shared_contexts`
- `execution_events`
- `agent_evaluations`
- `approval_requests`

## Recommended indexes

### agent_tasks
- `{ userId: 1, workflowRunId: 1 }`
- `{ workflowRunId: 1, status: 1 }`
- `{ workflowRunId: 1, agentId: 1 }`
- `{ workflowRunId: 1, dependsOnTaskIds: 1 }`

### agent_messages
- `{ userId: 1, workflowRunId: 1, createdAt: 1 }`
- `{ workflowRunId: 1, fromAgentId: 1 }`
- `{ workflowRunId: 1, toAgentId: 1 }`
- `{ workflowRunId: 1, taskId: 1 }`

### shared_contexts
- `{ userId: 1, workflowRunId: 1 }` (unique)

### execution_events
- `{ userId: 1, workflowRunId: 1, createdAt: 1 }`
- `{ workflowRunId: 1, type: 1 }`

### agent_evaluations
- `{ userId: 1, workflowRunId: 1 }`
- `{ workflowRunId: 1, targetTaskId: 1 }`

### approval_requests
- `{ userId: 1, workflowRunId: 1, status: 1 }`
- `{ workflowRunId: 1, status: 1 }`

## Notes

- All new documents carry `userId`, so every index prefixes it to enforce
  cross-user isolation at the query layer (in addition to application checks).
- Keep the latest 50–100 runs per user; allow users to delete old runs.
- Limit maximum message payload size; store large generated documents
  separately (GridFS or a `documents` collection).
- Do not store secrets inside messages, prompts, or execution traces.
