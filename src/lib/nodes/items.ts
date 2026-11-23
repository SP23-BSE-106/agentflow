/**
 * The item data model (n8n §4 of the feature map).
 *
 * The item is the unit of data: every node receives an array of items and
 * returns an array of items. `json` is the payload; `binary` is file data;
 * `pairedItem` records which input item(s) produced each output item, so
 * the editor can show the input behind any output; `error` carries a
 * per-item failure; `metadata` carries run bookkeeping such as the
 * sub-execution link for Execute Workflow nodes.
 */

export type WorkflowItem = {
  json: Record<string, unknown>
  binary?: Record<string, { data: string; mimeType: string; fileName: string }>
  error?: { message: string; node?: string }
  pairedItem?: number | { item: number; input?: number } | Array<{ item: number; input?: number }>
  metadata?: Record<string, unknown>
}

/** Wrap plain text as an item: `{ json: { input: text } }`. */
export function itemFromText(text: string): WorkflowItem {
  return { json: { input: text } }
}

/**
 * Render items back to text: the first item's `json.input` as a string
 * when it has one, else the JSON of the first item's `json`, else ''.
 */
export function itemsToText(items: WorkflowItem[]): string {
  if (!items || items.length === 0) return ''
  const first = items[0].json ?? {}
  if (typeof first.input === 'string') return first.input
  if (first.input !== undefined && first.input !== null) return String(first.input)
  return JSON.stringify(first)
}

/** Wrap a JSON payload as an item, optionally keeping its lineage. */
export function itemFromJson(
  json: Record<string, unknown>,
  pairedItem?: WorkflowItem['pairedItem'],
): WorkflowItem {
  const item: WorkflowItem = { json: { ...json } }
  if (pairedItem !== undefined) item.pairedItem = pairedItem
  return item
}
