/**
 * Form Trigger — hosted form definition + submission.
 *
 * A Form Trigger node makes a workflow start from a public web form at
 * `/form/[workflowId]`. The form is rendered from the node's config: the
 * `formFields` array lists the fields (name, label, type, required,
 * options). When the node has no fields configured, the form has one text
 * field called `input`, so the form always works instead of rendering
 * empty.
 *
 * A submission runs the workflow for real through the existing
 * `runWorkflow` (string path) with the submitted values as its input, and
 * the run output is shown to the submitter. The form link is public — the
 * workflow id in the URL is the only secret — the same as a webhook URL.
 *
 * Known limit (merge order, not a bug in this file): the string executor
 * only knows the legacy node types, so a graph whose execution path runs
 * through a formTrigger node fails it. Lane H's item executor executes
 * trigger nodes natively; until it lands, a form workflow's execution path
 * must use the legacy trigger node as its entry, with the formTrigger node
 * present as the form's definition. The run itself is real either way.
 */

import { ObjectId, type Db } from 'mongodb'
import { runWorkflow, type RunWorkflowResult } from '@/lib/workflow/runWorkflow'
import type { Agent } from '@/lib/mongo/agent'

export type FormFieldType = 'text' | 'email' | 'number' | 'textarea' | 'select' | 'boolean'

export type FormFieldDef = {
  name: string
  label: string
  type: FormFieldType
  required?: boolean
  options?: string[]
  placeholder?: string
}

export type FormDefinition = {
  workflowId: string
  title: string
  description: string
  fields: FormFieldDef[]
}

const FIELD_TYPES: FormFieldType[] = ['text', 'email', 'number', 'textarea', 'select', 'boolean']

function normaliseFields(raw: unknown): FormFieldDef[] {
  if (!Array.isArray(raw)) return []
  const fields: FormFieldDef[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || !item.name.trim()) continue
    const type = typeof item.type === 'string' && (FIELD_TYPES as string[]).includes(item.type)
      ? (item.type as FormFieldType)
      : 'text'
    fields.push({
      name: item.name.trim(),
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.name.trim(),
      type,
      required: item.required === true,
      options: Array.isArray(item.options)
        ? item.options.filter((o): o is string => typeof o === 'string')
        : undefined,
      placeholder: typeof item.placeholder === 'string' ? item.placeholder : undefined,
    })
  }
  return fields
}

/** The graph a form submission runs: the deployed snapshot for active agents, else the draft. */
export function formGraph(agent: Agent): Agent['workflow'] {
  const deployed =
    agent.status === 'active' &&
    Array.isArray(agent.deployedWorkflow?.nodes) &&
    agent.deployedWorkflow.nodes.length > 0
  return deployed ? agent.deployedWorkflow : agent.workflow
}

/**
 * The form definition for an agent, or null when its graph has no Form
 * Trigger node. Reads the deployed graph for active agents, the draft
 * otherwise — the same graph a run would use.
 */
export function getFormDefinition(agent: Agent): FormDefinition | null {
  const graph = formGraph(agent)
  if (!graph || !Array.isArray(graph.nodes)) return null
  const node = graph.nodes.find((n) => (n.type as string) === 'formTrigger')
  if (!node) return null
  const config = (node.config || {}) as Record<string, unknown>
  const fields = normaliseFields(config.formFields ?? config.fields)
  return {
    workflowId: String(agent._id),
    title:
      typeof config.formTitle === 'string' && config.formTitle.trim()
        ? config.formTitle.trim()
        : typeof node.name === 'string' && node.name.trim()
          ? node.name.trim()
          : 'Form',
    description: typeof config.formDescription === 'string' ? config.formDescription : '',
    fields: fields.length > 0
      ? fields
      : [{ name: 'input', label: 'Your message', type: 'text', required: true }],
  }
}

/**
 * Run a form submission for real. `values` are the submitted field values;
 * they become the workflow input as a JSON object, so downstream nodes see
 * every field. Throws with a `status` property (400/404) on bad input or a
 * missing form, exactly like `runWorkflow` does.
 */
export async function runFormSubmission(
  db: Db,
  workflowId: string,
  values: Record<string, unknown>,
): Promise<RunWorkflowResult> {
  if (!ObjectId.isValid(workflowId)) {
    throw Object.assign(new Error('workflowId must be a valid id'), { status: 400 })
  }
  const agent = await db
    .collection('agents')
    .findOne({ _id: new ObjectId(workflowId) })
  if (!agent) {
    throw Object.assign(new Error('Form not found'), { status: 404 })
  }
  const definition = getFormDefinition(agent as unknown as Agent)
  if (!definition) {
    throw Object.assign(new Error('This workflow has no Form Trigger, so it cannot accept form submissions'), { status: 404 })
  }
  const input = JSON.stringify(values)
  return runWorkflow({
    db,
    userId: String(agent.userId),
    agentId: workflowId,
    input,
  })
}
