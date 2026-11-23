/**
 * Triggers — webhook, schedule, form and Respond To Webhook (Lane G).
 *
 * Everything in this folder is original code written fresh for AgentFlow,
 * guided by the paraphrased behaviour in
 * `~/workspace/fypagentflow-audit/n8n-feature-map.md`. No n8n code was
 * copied. Schedules fire only when `POST /api/triggers/check` is called
 * (Vercel cron entry in `vercel.json`, or a manual hit) — never by magic.
 */

export * from './schedule'
export * from './webhooks'
export * from './respond'
export * from './forms'
// Node descriptions are canonical in Lane E's registry
// (src/lib/nodes/registry.ts + src/lib/nodes/index.ts). The trigger
// descriptions Lane G wrote for its own tests lived here and duplicated
// the registry — they were removed at merge time; getNodeType() is the
// single source of truth.
