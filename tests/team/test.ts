/* Team conversation-loop unit checks (lane A).
 *   npm run test:team   (tsc -p tests/team/tsconfig.json && node tests/team/out/tests/team/test.js)
 * Pure logic + injected LLM/persist fakes only — no database, no network,
 * no secrets. These are UNIT tests: they prove the parser, the turn-taking,
 * the cap and the budget. They do NOT prove a live provider conversation;
 * that is the live-proof step in the lane report.
 */
import { parseTeamTurn } from '../../src/lib/orchestration/teamTurn'
import {
  resolveTeammate,
  runTeamConversation,
} from '../../src/lib/orchestration/teamLoop'
import type { TeamAgent } from '../../src/lib/orchestration/teamTypes'

let pass = 0
const failures: string[] = []

function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      pass += 1
      console.log(`  PASS  ${name}`)
    })
    .catch((err) => {
      failures.push(name)
      console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
    })
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`)
}

function includes(haystack: string, needle: string, what: string) {
  if (!haystack.includes(needle)) throw new Error(`${what}: expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`)
}

const TEAM: TeamAgent[] = [
  { id: 'agent-lead', name: 'Lead', role: 'planner' },
  { id: 'agent-research', name: 'Researcher', role: 'researcher' },
  { id: 'agent-writer', name: 'Writer', role: 'writer' },
]

function scriptedComplete(script: string[]) {
  let i = 0
  return async () => {
    const text = script[Math.min(i, script.length - 1)]
    i += 1
    return { text, model: 'test', provider: 'test', ok: true as const }
  }
}

function memoryPersist() {
  const saved: Array<{ fromAgentId: string; toAgentId?: string; parentMessageId?: string; type: string; text: string; requiresResponse: boolean }> = []
  let n = 0
  return {
    saved,
    persist: async (args: {
      fromAgentId: string
      toAgentId?: string
      parentMessageId?: string
      type: 'task' | 'result'
      text: string
      requiresResponse: boolean
    }) => {
      saved.push(args)
      n += 1
      return { id: `msg-${n}` }
    },
  }
}

async function main() {
  console.log('team unit checks:')

  // ── Parser ────────────────────────────────────────────────────────
  await t('parser: final JSON', () => {
    eq(parseTeamTurn('{"kind":"final","text":"done here"}'), { kind: 'final', text: 'done here' }, 'final')
  })
  await t('parser: message JSON with requiresResponse', () => {
    eq(
      parseTeamTurn('{"kind":"message","to":"researcher","text":"find the figures","requiresResponse":true}'),
      { kind: 'message', to: 'researcher', text: 'find the figures', requiresResponse: true },
      'message',
    )
  })
  await t('parser: message defaults requiresResponse to false', () => {
    eq(
      parseTeamTurn('{"kind":"message","to":"agent-research","text":"note this"}'),
      { kind: 'message', to: 'agent-research', text: 'note this', requiresResponse: false },
      'message default',
    )
  })
  await t('parser: fenced ```json block', () => {
    eq(
      parseTeamTurn('```json\n{"kind":"final","text":"fenced answer"}\n```'),
      { kind: 'final', text: 'fenced answer' },
      'fenced',
    )
  })
  await t('parser: plain text becomes a final, never a message', () => {
    eq(parseTeamTurn('Just answer in plain words.'), { kind: 'final', text: 'Just answer in plain words.' }, 'plain')
  })
  await t('parser: invalid JSON becomes a final with the whole output', () => {
    eq(parseTeamTurn('{"kind":"message", broken'), { kind: 'final', text: '{"kind":"message", broken' }, 'broken json')
  })
  await t('parser: message without a recipient becomes a final', () => {
    const out = parseTeamTurn('{"kind":"message","text":"hello?"}')
    eq(out.kind, 'final', 'no-to kind')
    if (out.kind === 'final') includes(out.text, 'hello?', 'no-to text')
  })
  await t('parser: message without text becomes a final', () => {
    eq(parseTeamTurn('{"kind":"message","to":"Researcher"}').kind, 'final', 'no-text kind')
  })
  await t('parser: unknown kind becomes a final', () => {
    eq(parseTeamTurn('{"kind":"shout","text":"hey"}').kind, 'final', 'unknown kind')
  })
  await t('parser: non-object JSON becomes a final', () => {
    eq(parseTeamTurn('[1,2,3]').kind, 'final', 'array kind')
  })
  await t('parser: empty output becomes an empty final', () => {
    eq(parseTeamTurn('   '), { kind: 'final', text: '' }, 'empty')
  })

  // ── Teammate resolution ───────────────────────────────────────────
  await t('resolve: by id', () => {
    eq(resolveTeammate(TEAM, 'agent-research')?.name, 'Researcher', 'by id')
  })
  await t('resolve: by name, case-insensitive', () => {
    eq(resolveTeammate(TEAM, 'WRITER')?.id, 'agent-writer', 'by name')
  })
  await t('resolve: by role', () => {
    eq(resolveTeammate(TEAM, 'researcher')?.id, 'agent-research', 'by role')
  })
  await t('resolve: unknown reference is null (never a silent fallback)', () => {
    eq(resolveTeammate(TEAM, 'ghost'), null, 'unknown')
  })

  // ── Loop: two-agent question and answer ───────────────────────────
  await t('loop: lead asks researcher, reply returns, lead finishes', async () => {
    const store = memoryPersist()
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Summarise the 2026 figures.',
        team: TEAM,
      },
      {
        complete: scriptedComplete([
          '{"kind":"message","to":"researcher","text":"What are the 2026 figures?","requiresResponse":true}',
          '{"kind":"final","text":"The 2026 figures are 42 and 17."}',
          '{"kind":"final","text":"Summary: 42 and 17."}',
        ]),
        persist: store.persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'completed', 'status')
    eq(result.finalText, 'Summary: 42 and 17.', 'final text')
    eq(result.exchanges, 3, 'exchanges')
    eq(result.messagesCreated, 3, 'messages created')
    eq(result.transcript.map((e) => e.kind), ['message', 'final', 'final'], 'transcript kinds')
    eq(store.saved[0].type, 'task', 'question is a task message')
    eq(store.saved[0].toAgentId, 'agent-research', 'question recipient')
    eq(store.saved[0].requiresResponse, true, 'question requiresResponse')
    eq(store.saved[1].type, 'result', 'reply is a result message')
    eq(store.saved[1].toAgentId, 'agent-lead', 'reply returns to asker')
    eq(store.saved[1].parentMessageId, 'msg-1', 'reply threads under the question')
    eq(store.saved[2].type, 'result', 'final is a result message')
  })

  // ── Loop: nested delegation returns up the chain ──────────────────
  await t('loop: nested A→B→C returns through B to A', async () => {
    const store = memoryPersist()
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Nested job.',
        team: TEAM,
      },
      {
        complete: scriptedComplete([
          '{"kind":"message","to":"Researcher","text":"Get the number.","requiresResponse":true}',
          '{"kind":"message","to":"Writer","text":"Check the number 42.","requiresResponse":true}',
          '{"kind":"final","text":"42 checks out."}',
          '{"kind":"final","text":"The number is 42."}',
          '{"kind":"final","text":"Done: the number is 42."}',
        ]),
        persist: store.persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'completed', 'status')
    eq(result.exchanges, 5, 'exchanges')
    eq(result.finalText, 'Done: the number is 42.', 'final text')
    eq(result.transcript[3].toName, 'Lead', 'middle reply returns to lead')
    eq(result.transcript[3].kind, 'final', 'middle reply is a final')
  })

  // ── Loop: cap ─────────────────────────────────────────────────────
  await t('loop: endless messaging hits the cap honestly', async () => {
    const store = memoryPersist()
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Never-ending job.',
        team: TEAM,
        maxExchanges: 3,
      },
      {
        complete: scriptedComplete([
          '{"kind":"message","to":"Researcher","text":"ping","requiresResponse":true}',
          '{"kind":"message","to":"Lead","text":"pong","requiresResponse":true}',
          '{"kind":"message","to":"Researcher","text":"ping","requiresResponse":true}',
        ]),
        persist: store.persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'cap-exceeded', 'status')
    eq(result.exchanges, 3, 'exchanges stop at the cap')
    eq(result.finalText, '', 'no fake final text')
    includes(result.note ?? '', 'cap of 3', 'note names the cap')
    includes(result.note ?? '', 'not a completed job', 'note is honest')
  })

  // ── Loop: time budget ─────────────────────────────────────────────
  await t('loop: time budget stops the run honestly', async () => {
    const store = memoryPersist()
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Slow job.',
        team: TEAM,
        timeBudgetMs: 1,
      },
      {
        complete: async () => {
          await new Promise((resolve) => setTimeout(resolve, 15))
          return { text: '{"kind":"message","to":"Researcher","text":"ping","requiresResponse":false}', model: 'test', provider: 'test', ok: true as const }
        },
        persist: store.persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'budget-exceeded', 'status')
    eq(result.exchanges, 1, 'one turn ran before the budget check stopped the next')
    includes(result.note ?? '', 'time budget', 'note names the budget')
  })

  // ── Loop: unknown teammate ────────────────────────────────────────
  await t('loop: message to a non-teammate fails honestly, nothing sent to them', async () => {
    const store = memoryPersist()
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Job with a ghost.',
        team: TEAM,
      },
      {
        complete: scriptedComplete([
          '{"kind":"message","to":"ghost-agent","text":"hello?","requiresResponse":true}',
        ]),
        persist: store.persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'failed', 'status')
    eq(result.messagesCreated, 0, 'no message persisted')
    includes(result.note ?? '', 'ghost-agent', 'note names the bad reference')
  })

  // ── Loop: provider failure ────────────────────────────────────────
  await t('loop: dead provider fails honestly, never a fake answer', async () => {
    const store = memoryPersist()
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Job with no provider.',
        team: TEAM,
      },
      {
        complete: async () => ({
          text: '',
          model: null,
          provider: null,
          ok: false as const,
          failures: [{ provider: 'OpenRouter (x)', message: '402: out of credits' }],
        }),
        persist: store.persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'failed', 'status')
    eq(result.finalText, '', 'no fake final text')
    includes(result.failureDetail ?? '', '402', 'failure detail kept')
  })

  // ── Loop: empty team ──────────────────────────────────────────────
  await t('loop: empty team fails honestly', async () => {
    const result = await runTeamConversation(
      {
        userId: 'u1',
        workflowId: 'w1',
        workflowRunId: 'r1',
        task: 'Nobody home.',
        team: [],
      },
      {
        complete: scriptedComplete(['{"kind":"final","text":"x"}']),
        persist: memoryPersist().persist,
        readContextText: async () => '',
        recordContribution: async () => undefined,
      },
    )
    eq(result.status, 'failed', 'status')
    eq(result.exchanges, 0, 'no turns taken')
  })

  console.log(`\nteam unit checks: ${pass} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log(`failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
