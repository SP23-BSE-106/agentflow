import { scheduleParallel } from '../../src/lib/orchestration/scheduler'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  const events: string[] = []
  const result = await scheduleParallel(
    [
      {
        id: 'a',
        dependsOnTaskIds: [],
        execute: async () => {
          events.push('a')
          return { nodeId: 'a', ok: true, output: 'A', durationMs: 0 }
        },
      },
      {
        id: 'b',
        dependsOnTaskIds: ['a'],
        execute: async () => {
          events.push('b')
          return { nodeId: 'b', ok: true, output: 'B', durationMs: 0 }
        },
      },
    ],
    { maxConcurrentTasks: 2, maxRunDurationMs: 1_000, maxMessagesPerRun: 10 },
  )
  assert(result.completed === 2, 'dependency chain should complete')
  assert(events.join(',') === 'a,b', 'dependent task must wait for its dependency')

  const capped = await scheduleParallel(
    [
      {
        id: 'only',
        dependsOnTaskIds: [],
        execute: async () => ({ nodeId: 'only', ok: true, durationMs: 0 }),
      },
    ],
    {
      maxConcurrentTasks: 1,
      maxRunDurationMs: 1_000,
      maxMessagesPerRun: 0,
      getMessageCount: async () => 0,
    },
  )
  assert(capped.cancelled.includes('only'), 'message budget must cancel unstarted work')
  console.log('Production hardening tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
