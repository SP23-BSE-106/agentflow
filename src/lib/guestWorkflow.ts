/**
 * Guest workflow storage (Lane B).
 *
 * A visitor with no account keeps their workflow in this browser only, in
 * localStorage under one versioned key. Nothing here touches the server and
 * nothing here touches auth: a guest's workflow never leaves their machine
 * until they log in and save it from the builder or the create page.
 *
 * The functions take an optional storage object so they stay testable in
 * plain node (where there is no `window.localStorage`); in the app the
 * default is the real browser storage. When no storage is available — a
 * server render, a blocked cookie/storage setting, or a full quota — reads
 * return null and writes return false instead of throwing.
 */

/**
 * The workflow shape the browser stores. It is deliberately looser than
 * `WorkflowGraph`: the builder's save payload carries node types as plain
 * strings (registry machine names come back from `toPersistedType` as
 * `string`), and the stored copy must accept exactly what the builder
 * saves — a strict `NodeType` union would reject it at compile time while
 * the same JSON sails through the server today. The loader (`loadWorkflow`
 * in the builder) already treats the graph as untyped, so nothing downstream
 * assumes more than this shape.
 */
export interface GuestWorkflowNode {
  id: string;
  name: string;
  type: string;
  description: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
  version?: number;
}

export interface GuestWorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface GuestWorkflowGraph {
  name?: string;
  description?: string;
  nodes: GuestWorkflowNode[];
  edges: GuestWorkflowEdge[];
}

/** One versioned key for the whole guest handoff. Bump the suffix if the shape changes. */
export const GUEST_WORKFLOW_KEY = "agentflow.guest-workflow.v1";

/** Where a generated workflow came from, per Lane A's response contract. */
export type WorkflowSource = "ai" | "template";

export interface GuestWorkflowStore {
  workflow: GuestWorkflowGraph;
  /** Suggested agent name, when the create page had one. */
  name?: string;
  description?: string;
  /** The prompt the visitor typed, kept so the builder can show it back. */
  prompt?: string;
  source?: WorkflowSource;
  /** ISO timestamp of the last browser save. */
  savedAt?: string;
}

/** The smallest storage shape these helpers need (localStorage satisfies it). */
export interface GuestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): GuestStorage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    return null;
  }
  return null;
}

function isGuestWorkflowStore(value: unknown): value is GuestWorkflowStore {
  if (!value || typeof value !== "object") return false;
  const store = value as { workflow?: unknown };
  if (!store.workflow || typeof store.workflow !== "object") return false;
  const workflow = store.workflow as { nodes?: unknown };
  return Array.isArray(workflow.nodes);
}

/**
 * Read the guest's workflow from the browser, or null when there is none,
 * it is damaged, or no storage is available. A damaged entry is cleared so
 * a corrupt copy cannot block the builder's empty state forever.
 */
export function readGuestWorkflow(storage: GuestStorage | null = browserStorage()): GuestWorkflowStore | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(GUEST_WORKFLOW_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isGuestWorkflowStore(parsed)) {
      try {
        storage.removeItem(GUEST_WORKFLOW_KEY);
      } catch {
        // Clearing a damaged entry is best-effort only.
      }
      return null;
    }
    return parsed;
  } catch {
    try {
      storage.removeItem(GUEST_WORKFLOW_KEY);
    } catch {
      // Clearing a damaged entry is best-effort only.
    }
    return null;
  }
}

/** Write the guest's workflow to the browser. Returns false when it could not be stored. */
export function saveGuestWorkflow(
  store: GuestWorkflowStore,
  storage: GuestStorage | null = browserStorage(),
): boolean {
  if (!storage || !isGuestWorkflowStore(store)) return false;
  try {
    storage.setItem(
      GUEST_WORKFLOW_KEY,
      JSON.stringify({ ...store, savedAt: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Forget the browser copy. Used when the visitor starts over. */
export function clearGuestWorkflow(storage: GuestStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(GUEST_WORKFLOW_KEY);
  } catch {
    // Forgetting is best-effort only.
  }
}

export function hasGuestWorkflow(storage: GuestStorage | null = browserStorage()): boolean {
  return readGuestWorkflow(storage) !== null;
}

/**
 * Plain label for where a generated workflow came from, per Lane A's
 * contract (`source: 'ai' | 'template'`, with `_mock` kept alongside).
 * `source` wins when present; without it, a mock/template fallback reads
 * as a template and anything else reads as built by the AI.
 */
export function workflowSourceLabel(
  source: unknown,
  mock?: unknown,
): "Built by the AI" | "Suggested from a template" {
  if (source === "template" || (source !== "ai" && mock === true)) return "Suggested from a template";
  return "Built by the AI";
}

/** Normalise a generate response's source flag to the contract, or null when it says nothing usable. */
export function workflowSourceFromResponse(data: { source?: unknown; _mock?: unknown }): WorkflowSource {
  if (data.source === "template" || data.source === "ai") return data.source;
  return data._mock === true ? "template" : "ai";
}

/**
 * The shape the Testing Sandbox and the builder's Run button share for a
 * browser-held workflow (Lane C). Same single key as the rest of this file —
 * the writer (Lane B) and the readers (Lane C) must never disagree on it.
 * Accepts the wrapped store above and, for robustness, a bare graph
 * ({ nodes, edges }) stored under the same key.
 */
export type GuestWorkflow = {
  workflow: { nodes: unknown[]; edges?: unknown[]; name?: unknown };
  /** Display name for the workflow, if the stored copy has one. */
  name: string;
};

/**
 * Read the guest workflow for running, or null when there is none (or it is
 * not a runnable workflow object). Never throws. A damaged entry is cleared
 * so a corrupt copy cannot block the sandbox forever; an entry with zero
 * steps is not damaged, it is simply nothing to run.
 */
export function loadGuestWorkflow(): GuestWorkflow | null {
  const storage = browserStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(GUEST_WORKFLOW_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      storage.removeItem(GUEST_WORKFLOW_KEY);
    } catch {
      // Clearing a damaged entry is best-effort only.
    }
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // Wrapped store ({ workflow: { nodes, edges }, name }) or bare graph.
  const graph =
    record.workflow && typeof record.workflow === "object" && !Array.isArray(record.workflow)
      ? (record.workflow as Record<string, unknown>)
      : record;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
  const name =
    (typeof record.name === "string" && record.name.trim()) ||
    (typeof graph.name === "string" && graph.name.trim()) ||
    "Your workflow";
  return {
    workflow: {
      nodes: graph.nodes as unknown[],
      edges: Array.isArray(graph.edges) ? (graph.edges as unknown[]) : [],
      name,
    },
    name,
  };
}
