const baseUrl = process.env.AGENTFLOW_E2E_URL
const cookie = process.env.AGENTFLOW_E2E_COOKIE
const agentId = process.env.AGENTFLOW_E2E_AGENT_ID

if (!baseUrl || !cookie || !agentId) {
  console.error(
    'E2E FAILED: set AGENTFLOW_E2E_URL, AGENTFLOW_E2E_COOKIE, and AGENTFLOW_E2E_AGENT_ID before running this test. ' +
      'It needs a running deployment, a signed-in session cookie, and a real agent id, so it cannot run without them.',
  )
  process.exit(2)
}

const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/orchestrate`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookie,
  },
  body: JSON.stringify({
    agentId,
    input: 'Run the configured workflow and return a concise result.',
    mode: 'parallel',
  }),
})

const body = await response.json()
if (!response.ok || !body.runId || !['completed', 'failed', 'paused'].includes(body.status)) {
  throw new Error(`Orchestration E2E failed (${response.status}): ${JSON.stringify(body)}`)
}

console.log(`Orchestration E2E passed: ${body.runId} (${body.status})`)
