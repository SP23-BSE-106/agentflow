/**
 * Hosted form page: /form/[workflowId]
 *
 * Renders the workflow's Form Trigger node as a plain form — fields, labels
 * and required marks come from the node's `formFields` config, so what the
 * builder shows is what the visitor gets. Submitting posts to
 * `/api/forms/[workflowId]`, which runs the workflow for real and shows the
 * result. No JavaScript is needed on this page.
 *
 * The link is public: anyone with the workflow id can open it, the same as
 * a webhook URL. Do not put a form on a workflow whose run would do
 * something you would not want a stranger to trigger.
 */

import { ObjectId } from 'mongodb'

import { getDb } from '@/lib/mongo/mongo'
import { getFormDefinition, type FormFieldDef } from '@/lib/triggers/forms'
import type { Agent } from '@/lib/mongo/agent'

function fieldInput(field: FormFieldDef) {
  const common = {
    id: field.name,
    name: field.name,
    required: field.required === true,
    placeholder: field.placeholder || undefined,
  }
  switch (field.type) {
    case 'textarea':
      return <textarea {...common} rows={4} className="textarea" />
    case 'select':
      return (
        <select {...common} className="select">
          <option value="">Choose…</option>
          {(field.options || []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )
    case 'boolean':
      return <input type="checkbox" {...common} value="true" className="accent-[var(--accent)]" />
    case 'number':
      return <input type="number" {...common} className="input" />
    case 'email':
      return <input type="email" {...common} className="input" />
    default:
      return <input type="text" {...common} className="input" />
  }
}

export default async function FormPage({
  params,
}: {
  params: Promise<{ workflowId: string }>
}) {
  const { workflowId } = await params

  if (!ObjectId.isValid(workflowId)) {
    return (
      <main className="mx-auto w-full max-w-[640px] px-6 py-12">
        <h1>Form not found</h1>
        <p className="text-[var(--muted)]">This form link is not valid.</p>
      </main>
    )
  }

  let definition = null
  try {
    const db = await getDb()
    const agent = await db.collection('agents').findOne({ _id: new ObjectId(workflowId) })
    if (agent) definition = getFormDefinition(agent as unknown as Agent)
  } catch {
    definition = null
  }

  if (!definition) {
    return (
      <main className="mx-auto w-full max-w-[640px] px-6 py-12">
        <h1>Form not available</h1>
        <p className="text-[var(--muted)]">This workflow has no form to fill in. The owner may have removed its Form Trigger.</p>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-[640px] px-6 py-12">
      <div className="panel p-6">
        <h1>{definition.title}</h1>
        {definition.description ? <p className="text-[var(--muted)]">{definition.description}</p> : null}
        <form method="post" action={`/api/forms/${definition.workflowId}`}>
          {definition.fields.map((field) => (
            <div key={field.name} className="mb-4">
              <label htmlFor={field.name} className="mb-1 block text-sm font-semibold text-[var(--text)]">
                {field.label}
                {field.required ? ' *' : ''}
              </label>
              {fieldInput(field)}
            </div>
          ))}
          <button type="submit" className="btn btn-primary">Submit</button>
        </form>
      </div>
    </main>
  )
}
