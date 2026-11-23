"use client";

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import * as React from "react";
import { useSearchParams, useRouter } from "next/navigation";
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  useStore,
  Node,
  Edge,
  Handle,
  Position,
  Connection,
} from "reactflow";
import "reactflow/dist/style.css";

import { BuilderLayout } from "@/components/layout/BuilderLayout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  Trash2,
  Send,
  Bot,
  Plus,
  Undo2,
  X,
  ChevronDown,
} from "lucide-react";
import { AppMark, connectionForNode, providerForModel } from "@/components/icons/app-icons";
import {
  NODE_CATALOG,
  QUICK_COMMANDS,
  applyActions,
  findFreeSlot,
  labelOf,
  planAddNode,
  runKimiCommand,
  toCanvasType,
  toPersistedType,
  typeOf,
  uniqueLabel,
} from "@/lib/workflow/kimiEngine";
import {
  defaultVersion,
  getNodeType,
  listNodeTypes,
  type NodeDescription,
  type NodeProperty,
} from "@/lib/nodes";
import { readGuestWorkflow, saveGuestWorkflow } from "@/lib/guestWorkflow";

/**
 * The app mark for a node kind: the recognisable mark of the app or service
 * the step involves (OpenRouter, NVIDIA, Hugging Face, Moonshot for AI
 * steps; files, web, link, clock, and so on for the rest), drawn as an
 * original inline SVG in `@/components/icons/app-icons`. For an AI step the
 * mark follows the model picked in the step's settings, so the card shows
 * which provider actually answers. Deliberately a small wrapper rather
 * than a lookup table of components: resolving a component through a map
 * during render is exactly what react-hooks/static-components warns about.
 */
const TypeIcon = ({
  type,
  className,
  config,
}: {
  type?: string;
  className?: string;
  config?: Record<string, unknown> | null;
}) => {
  const connection = connectionForNode(type, config);
  return <AppMark markKey={connection.key} className={className} />;
};

/** The small tile an app mark sits in: hairline border, 2px radius, surface-2. */
const TypeIconTile = ({
  type,
  config,
  selected,
}: {
  type?: string;
  config?: Record<string, unknown> | null;
  selected?: boolean;
}) => (
  <span
    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border bg-[var(--surface-2)] ${
      selected ? "border-[var(--accent)]" : "border-[var(--border)]"
    }`}
  >
    <TypeIcon type={type} config={config} className="icon-sm text-[var(--accent)]" />
  </span>
);

/** Narrow canvas: below this React Flow width the whole-graph fit shrinks
 * cards unreadably small at 390px (B7), so fits target a subset instead.
 * 640 matches the Tailwind `sm` breakpoint (the minimap hides below it). */
const NARROW_FIT_WIDTH = 640;

/** Ids of the leftmost column: the workflow's first steps. Node positions
 * are grid values, so the minimum x names the column exactly. */
const firstColumnIds = (nodes: { id: string; position: { x: number; y: number } }[]) => {
  if (nodes.length === 0) return [];
  const minX = Math.min(...nodes.map((n) => n.position.x));
  return nodes.filter((n) => n.position.x - minX < 1).map((n) => ({ id: n.id }));
};

/** The viewport width below which a canvas counts as narrow (a phone).
 * Read at the moment of the add, so a resize between renders cannot
 * place a step in the wrong lattice: narrow adds stack in one column
 * (H15), wide adds use the 4-column grid. */
const isNarrowViewport = () =>
  typeof window !== "undefined" && window.innerWidth < NARROW_FIT_WIDTH;

/**
 * Fits the viewport to whatever is on the canvas. Lives *inside* ReactFlow so
 * it can reach `useReactFlow`, and only runs when the token changes — adding a
 * node from the library or from Kimi would otherwise drop it out of view.
 *
 * Two guards, learned from the no-auth red-team (Lane D2): React Flow's
 * fitView is a silent no-op while ANY node is still unmeasured, and a new
 * node only gets its size after layout — so a fit fired in the same commit
 * as the add sees the new node with no size and does nothing. The canvas
 * then stayed on the first step's fit (2x zoom, capped), with every later
 * step fitted never and landing off-canvas under the Helper panel, where
 * its handle cannot be dragged. So the fit runs after layout, names every
 * node explicitly, never zooms past 1x, and runs once more after the
 * animation settles — the second pass catches a first pass that no-opped.
 * (H14: this is the fixed AutoFit ported from the no-auth build; the old
 * auth version called fitView with no node subset and no maxZoom, so it
 * fitted the first step at ~2x and never re-fitted.)
 *
 * Narrow canvases (B7): fitting the whole graph at 390px shrinks a
 * 2-column workflow to ~0.54x — cards 138px wide, body text ~6px. So on
 * a canvas narrower than 640px the fit targets a subset instead: the
 * step just added (`latest`, so an add lands legibly in view) or the
 * first column (`first`, so a generated workflow starts legible); the
 * rest of the graph is a pan away. Wide canvases fit everything, as
 * before. `width`/`mode` are read from the token-change render.
 *
 * Narrow canvases (H15): that subset rule is wrong for a flow the user
 * just built by adding steps one by one on a phone — the adds now stack
 * in a single vertical column (see `isNarrowViewport`), so a 4-step flow
 * spans one card width and fitting it whole stays legible. The fit
 * therefore tries the whole graph first and only falls back to the
 * subset when the fitted zoom would drop below 0.35 (a long flow, where
 * whole-graph would shrink cards to postage stamps). The zoom is
 * estimated from the measured node bounds against the viewport, with
 * the same 0.3 padding fitView applies.
 */
const AutoFit = ({ token, mode }: { token: number; mode: "first" | "latest" }) => {
  const { fitView, getNodes } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  React.useEffect(() => {
    if (token <= 0) return;
    let cancelled = false;
    const fitAll = () => {
      if (cancelled) return;
      const nodes = getNodes();
      if (nodes.length === 0) return;
      if (width && width < NARROW_FIT_WIDTH) {
        // H15: estimate the zoom a whole-graph fit would pick, from the
        // measured node bounds against the viewport (0.3 padding on
        // each side, as fitView applies it). At 0.35 or above the whole
        // flow stays readable, so fit it whole; below that, fall back
        // to the B7 subset fit.
        const measured = nodes.map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          w: n.width ?? 256,
          h: n.height ?? 170,
        }));
        const minX = Math.min(...measured.map((n) => n.x));
        const minY = Math.min(...measured.map((n) => n.y));
        const maxX = Math.max(...measured.map((n) => n.x + n.w));
        const maxY = Math.max(...measured.map((n) => n.y + n.h));
        const spanW = Math.max(1, maxX - minX);
        const spanH = Math.max(1, maxY - minY);
        const zoomAll = Math.min(width / (spanW * 1.6), (height || 600) / (spanH * 1.6));
        if (zoomAll >= 0.35) {
          void fitView({
            nodes: measured.map((n) => ({ id: n.id })),
            padding: 0.3,
            duration: 300,
            maxZoom: 1,
          });
          return;
        }
        if (mode === "latest") {
          const last = nodes[nodes.length - 1];
          void fitView({ nodes: [{ id: last.id }], padding: 0.3, duration: 300, maxZoom: 1 });
        } else {
          void fitView({ nodes: firstColumnIds(nodes), padding: 0.3, duration: 300, maxZoom: 1 });
        }
        return;
      }
      const ids = nodes.map((n) => ({ id: n.id }));
      void fitView({ nodes: ids, padding: 0.3, duration: 300, maxZoom: 1 });
    };
    const raf = requestAnimationFrame(() => {
      window.setTimeout(fitAll, 60);
    });
    const settle = window.setTimeout(fitAll, 500);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [token]);
  return null;
};

/**
 * Mount-only fit for narrow canvases (B7). React Flow's initial `fitView`
 * fits the whole graph, which at 390px shrinks a 2-column workflow to
 * ~0.54x. On a canvas narrower than 640px this re-fits once, shortly
 * after mount, to the leftmost column (the workflow's first steps) at up
 * to 1x, so the start is legible and the rest is a pan away — the same
 * two-pass shape as AutoFit, so a workflow loaded from storage just
 * after mount is caught by the settle pass. Wide canvases are untouched
 * (the initial fitView already fits all), and later resizes never refit,
 * so a view the user panned or zoomed deliberately is never moved.
 */
const NarrowInitialFit = () => {
  const { fitView, getNodes } = useReactFlow();
  const width = useStore((s) => s.width);
  const doneRef = React.useRef(false);
  const mountedAtRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (mountedAtRef.current === null) mountedAtRef.current = Date.now();
    if (doneRef.current || !width || width >= NARROW_FIT_WIDTH) return;
    if (mountedAtRef.current !== null && Date.now() - mountedAtRef.current > 3000) return;
    doneRef.current = true;
    let cancelled = false;
    const fitFirst = () => {
      if (cancelled) return;
      const nodes = getNodes();
      if (nodes.length === 0) return;
      void fitView({ nodes: firstColumnIds(nodes), padding: 0.3, duration: 300, maxZoom: 1 });
    };
    const raf = requestAnimationFrame(() => {
      window.setTimeout(fitFirst, 60);
    });
    const settle = window.setTimeout(fitFirst, 500);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [width]);
  return null;
};

/**
 * Re-fits once when the canvas width moves shortly after mount.
 * Merge interaction (Lane C x Lane D): the canvas mounts with both
 * side panels closed (Lane D: panels start closed so the server HTML
 * is correct on phones) and React Flow's initial `fitView` fits the
 * workflow to that full-width canvas; the mount effect then opens
 * both panels on desktop, the canvas narrows by ~560px, and the
 * fitted zoom goes stale — the right column of cards runs off the
 * canvas and the fit-aware minimap pops up over the top-right card.
 * Watching the width and re-fitting once when it first moves keeps
 * the end state fitted, without ever touching a view the user panned
 * or zoomed deliberately (later resizes do not refit).
 */
const RefitAfterPanelsOpen = () => {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const nodeCount = useStore((s) => s.nodeInternals.size);
  const firstWidthRef = React.useRef<number | null>(null);
  const doneRef = React.useRef(false);
  const mountedAtRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (mountedAtRef.current === null) mountedAtRef.current = Date.now();
    if (doneRef.current || nodeCount === 0 || !width) return;
    if (firstWidthRef.current === null) {
      firstWidthRef.current = width;
      return;
    }
    // Panels opening narrows the canvas by hundreds of px within a
    // frame or two of mount; a later window resize is not this.
    if (Math.abs(width - firstWidthRef.current) > 50 && mountedAtRef.current !== null && Date.now() - mountedAtRef.current < 3000) {
      doneRef.current = true;
      // H14: cap at 1x like every other fit — an uncapped refit could put a
      // one-step canvas back at ~2x, the exact defect this lane fixes.
      void fitView({ padding: 0.3, duration: 300, maxZoom: 1 });
    }
  }, [width, nodeCount, fitView]);
  return null;
};

// Ledger-panel node: surface, 4px radius, hairline border, mono id,
// status lamp + word. Teal appears only on the selected node. The lamp
// reads the node's own connection state (display only, from the store):
// a node with no edge cannot run, so it reads Unlinked in amber; a
// connected node reads Connected in teal.
const CustomNodeComponent = ({ id, data, selected }: { id: string; data: any; selected: boolean }) => {
  const { deleteElements } = useReactFlow();
  const connected = useStore((s) => s.edges.some((e) => e.source === id || e.target === id));

  /** Deleting from the card itself, without a trip through the side panel.
   *  React Flow removes the attached edges along with the node. */
  const handleCardDelete = (event: React.MouseEvent) => {
    event.stopPropagation();
    deleteElements({ nodes: [{ id }] });
  };

  // Node cards are w-64 (not w-52): the plain-words connection line under
  // the title — e.g. "Form start · someone fills a form" (35 chars at 8px
  // mono) — must fit on one line; at w-52 it truncated mid-word.
  return (
    <div
      className={`group relative rounded-[4px] border bg-[var(--surface)] p-3 text-left w-64 ${
        selected ? "border-[var(--accent)]" : "border-[var(--border)] hover:border-[var(--border-strong)]"
      }`}
    >
      <button
        type="button"
        data-card-control
        aria-label={`Delete ${data.label}`}
        title={`Delete ${data.label}`}
        onClick={handleCardDelete}
        onMouseDown={(e) => e.stopPropagation()}
        className="nodrag nopan absolute -right-2.5 -top-2.5 z-10 flex h-6 w-6 items-center justify-center rounded-[2px] border border-[var(--border)] bg-[var(--surface)] text-muted opacity-60 transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
      >
        <X className="icon-xs" />
      </button>

      {/* Top Handles */}
      {data.type !== "Input" && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: selected ? "var(--accent)" : "var(--surface)", borderColor: "var(--border-strong)" }}
        />
      )}

      <div className="flex items-center gap-2 mb-2 pr-4">
        <TypeIconTile type={data.type} config={data.config} selected={selected} />
        <div className="flex flex-col text-left min-w-0">
          <span className="text-[11px] font-semibold text-[var(--text)] leading-none truncate">{data.label}</span>
          {/* What the step connects to, in plain words — e.g. "AI step · OpenRouter". */}
          <span className="font-mono text-[8px] text-muted tracking-wide uppercase mt-0.5 truncate">
            {connectionForNode(data.type, data.config).label}
          </span>
        </div>
      </div>

      <p className="text-[9px] text-muted leading-relaxed font-medium mt-1 select-none">
        {data.description}
      </p>

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2">
        <span className="truncate font-mono text-[9px] text-muted">{id}</span>
        <span className="status-line shrink-0 text-[10px]">
          <span className={`lamp ${connected ? "lamp-ok" : "lamp-paused"}`} />
          {connected ? "Connected" : "Unlinked"}
        </span>
      </div>

      {/* Bottom Handles */}
      {data.type !== "Output" && (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: selected ? "var(--accent)" : "var(--surface)", borderColor: "var(--border-strong)" }}
        />
      )}
    </div>
  );
};

/** Plain kind name shown on a step card. Built-in kinds get plain words;
 *  automation steps get a plain reading of their display name where one
 *  exists, otherwise the display name itself. Display only — the stored
 *  type is untouched. */
const PLAIN_KIND_NAMES: Record<string, string> = {
  Input: "Start",
  "LLM Node": "AI step",
  "RAG Node": "Your files",
  "API Node": "Web call",
  Condition: "Choice",
  Output: "Answer",
  Webhook: "Link start",
  "Schedule Trigger": "Timed start",
  "Manual Trigger": "Button start",
  "Form Trigger": "Form start",
  "Error Trigger": "Error start",
  "Execute Workflow Trigger": "Called by another flow",
  "Respond To Webhook": "Reply to the link",
  "Execute Workflow": "Run another flow",
  "HTTP Request": "Web call",
  "Split In Batches": "In small groups",
  Code: "Run code",
  Set: "Set values",
  If: "Choice",
  Switch: "Choice",
  Merge: "Join flows",
  Wait: "Pause",
};
const plainKindName = (type?: string) => (type ? PLAIN_KIND_NAMES[type] ?? type : "");

const nodeTypes = {
  customNode: CustomNodeComponent,
};

// ── Properties-driven settings fields (registry nodes) ────────────────────
// The settings panel for an automation node is rendered from the node's
// `properties` array, not hand-built per node: one field per property, with
// the control chosen by the property's type and its default as the value
// when the node has nothing saved yet. This is the same shape the registry
// descriptions are written in, so a new node type gets a working panel
// for free.

/** Properties whose string value reads better as a multi-line editor. */
const LONG_TEXT_PROPERTIES = new Set(["code", "body", "responseBody"]);

/** Whether a property is shown for the current config values. */
function isPropertyVisible(prop: NodeProperty, config: Record<string, unknown>): boolean {
  const show = prop.displayOptions?.show;
  if (show) {
    for (const [key, allowed] of Object.entries(show)) {
      if (!allowed.includes(config[key])) return false;
    }
  }
  const hide = prop.displayOptions?.hide;
  if (hide) {
    for (const [key, blocked] of Object.entries(hide)) {
      if (blocked.includes(config[key])) return false;
    }
  }
  return true;
}

const RegistryPropertyField = ({
  prop,
  value,
  onChange,
}: {
  prop: NodeProperty;
  value: unknown;
  onChange: (next: unknown) => void;
}) => {
  // The sign-in field is labelled in plain words; every other field keeps
  // the name the step itself gives it.
  const shownName = prop.name === "authentication" ? "Sign-in" : prop.displayName;
  const label = (
    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">
      {shownName}
      {prop.required ? " *" : ""}
    </label>
  );
  const hint = prop.description ? <p className="text-[10px] text-muted">{prop.description}</p> : null;
  const inputClass = "input w-full text-xs";

  if (prop.type === "options") {
    return (
      <div className="space-y-1.5">
        {label}
        <select
          value={typeof value === "string" ? value : String(prop.default)}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          {(prop.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.name}
            </option>
          ))}
        </select>
        {hint}
      </div>
    );
  }

  if (prop.type === "boolean") {
    return (
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          {prop.displayName}
          {prop.required ? " *" : ""}
        </label>
        {hint}
      </div>
    );
  }

  if (prop.type === "number") {
    return (
      <div className="space-y-1.5">
        {label}
        <input
          type="number"
          value={typeof value === "number" ? value : typeof prop.default === "number" ? prop.default : ""}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (!Number.isNaN(parsed)) onChange(parsed);
          }}
          className={inputClass}
        />
        {hint}
      </div>
    );
  }

  if (prop.type === "json" || prop.type === "collection") {
    return (
      <div className="space-y-1.5">
        {label}
        <textarea
          value={JSON.stringify(value ?? prop.default, null, 2)}
          onChange={(e) => {
            // Commit only valid JSON: a half-typed object is left as-is
            // on screen rather than saved broken.
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              // Not valid JSON yet — wait for the next keystroke.
            }
          }}
          spellCheck={false}
          className={`${inputClass} min-h-20 font-mono`}
        />
        {hint}
      </div>
    );
  }

  if (prop.type === "stringArray") {
    const lines = Array.isArray(value) ? (value as unknown[]).join("\n") : "";
    return (
      <div className="space-y-1.5">
        {label}
        <textarea
          value={lines}
          onChange={(e) => onChange(e.target.value.split("\n").map((line) => line.trim()).filter(Boolean))}
          placeholder="One value per line"
          className={`${inputClass} min-h-16`}
        />
        {hint}
      </div>
    );
  }

  if (prop.type === "credentials") {
    return (
      <div className="space-y-1.5">
        {label}
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="Saved sign-in"
          className={inputClass}
        />
        <p className="text-[10px] text-muted">
          {prop.description ?? "The saved sign-in for this service."}
        </p>
      </div>
    );
  }

  if (LONG_TEXT_PROPERTIES.has(prop.name)) {
    return (
      <div className="space-y-1.5">
        {label}
        <textarea
          value={typeof value === "string" ? value : String(prop.default ?? "")}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={`${inputClass} min-h-24 font-mono`}
        />
        {hint}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {label}
      <input
        type="text"
        value={typeof value === "string" ? value : typeof value === "number" ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={typeof prop.default === "string" ? prop.default : ""}
        className={inputClass}
      />
      {hint}
    </div>
  );
};

// Registry groups in palette order, with the heading shown above each group.
const REGISTRY_GROUP_ORDER: Array<{ group: string; heading: string }> = [
  { group: "trigger", heading: "Ways to start" },
  { group: "transform", heading: "Change things" },
  { group: "output", heading: "Finish" },
  { group: "organisation", heading: "Organise" },
];

// Empty canvas by default; workflows are loaded from Create Agent or an existing agent.
const initialNodes: Node[] = [];
const initialEdges: Edge[] = [];

function mapWorkflowToCanvas(workflow: any) {
  const mappedNodes: Node[] = (workflow?.nodes || []).map((n: any, i: number) => {
    // A persisted registry type (e.g. 'webhook') restores as the same
    // automation node — display name, machine name and version — instead
    // of falling back to an LLM node.
    const registryDesc = getNodeType(n.type);
    const entry = registryDesc ? null : toCanvasType(n.type);
    return {
      id: n.id,
      type: "customNode",
      // Saved positions are restored; only nodes saved before positions
      // were persisted fall back to the grid layout.
      position:
        typeof n.position?.x === "number" && typeof n.position?.y === "number"
          ? { x: n.position.x, y: n.position.y }
          // Column step 300: node cards are w-64 (256px), so the old 240
          // step overlapped neighbours by 16px.
          : { x: 260 + (i % 2) * 300, y: 80 + Math.floor(i / 2) * 180 },
      data: {
        label: n.name,
        type: registryDesc ? registryDesc.displayName : entry!.type,
        description: n.description,
        // Node config (model, system prompt, RAG index, API URL, condition
        // expression, per-node agent) rides on the canvas node so saving it
        // back cannot silently drop what execution reads.
        config: (n.config ?? {}) as Record<string, unknown>,
        ...(registryDesc
          ? {
              nodeType: registryDesc.name,
              registryVersion:
                typeof n.version === "number" ? n.version : registryDesc.version,
            }
          : {}),
      },
    };
  });

  const mappedEdges: Edge[] = (workflow?.edges || []).map((e: any) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // Edge labels ('true'/'false') are what Condition nodes branch on.
    label: typeof e.label === "string" ? e.label : undefined,
  }));

  return { nodes: mappedNodes, edges: mappedEdges };
}

function WorkflowBuilderInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const agentId = searchParams?.get("agentId");
  const agentNameFromQuery = searchParams?.get("agentName") ?? "";

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [isRunning, setIsRunning] = React.useState(false);

  // Selection is derived from React Flow's own `selected` flags instead of a
  // separate copy, so it can never go stale after a delete, a rename or an edit
  // made from the assistant.
  const selectedNodes = React.useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  const selectedEdges = React.useMemo(() => edges.filter((e) => e.selected), [edges]);
  const selectedNode = selectedNodes[0] ?? null;
  const hasSelection = selectedNodes.length > 0 || selectedEdges.length > 0;

  const [saveBusy, setSaveBusy] = React.useState(false);
  const [saveMessage, setSaveMessage] = React.useState<string | null>(null);
  const [assistantInput, setAssistantInput] = React.useState("");
  const [generateInput, setGenerateInput] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [addMenuOpen, setAddMenuOpen] = React.useState(false);
  // Left-panel disclosures. The plain steps start open; the automatic
  // steps start closed behind "More steps" so a layman sees the plain
  // list first. (Was: neither section had a toggle at all — the "Steps
  // to add" header was a plain div with no handler — and the automatic
  // list was a non-scrolling flex sibling whose content-sized minimum
  // height starved the plain list's scroll area down to a 32px sliver.)
  const [stepsOpen, setStepsOpen] = React.useState(true);
  const [moreStepsOpen, setMoreStepsOpen] = React.useState(false);
  const [fitToken, setFitToken] = React.useState(0);
  // Which subset AutoFit targets on a narrow canvas (B7): "first" fits
  // the workflow's first column (generate/load), "latest" fits the step
  // just added. Wide canvases always fit everything; the mode is inert
  // there. (H15: on narrow, AutoFit first tries the whole graph when
  // the fitted zoom stays readable, and only then uses this mode.)
  const [fitMode, setFitMode] = React.useState<"first" | "latest">("first");
  // Narrow canvas (H15): a phone-width canvas gets a lower zoom floor
  // so the fit-view control can frame a whole flow instead of stopping
  // at React Flow's 0.5 default and clipping the end nodes.
  const [isNarrowCanvas, setIsNarrowCanvas] = React.useState(false);
  React.useEffect(() => {
    const onResize = () => setIsNarrowCanvas(window.innerWidth < NARROW_FIT_WIDTH);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [canUndo, setCanUndo] = React.useState(false);
  const [assistantMessages, setAssistantMessages] = React.useState<Array<{ role: "assistant" | "user"; content: string }>>([
    {
      role: "assistant",
      content: "I'm ready. Ask me to add, remove, rename or connect steps and I'll update the canvas straight away.",
    },
  ]);
  const [logs, setLogs] = React.useState<string[]>([
    "[Note] Canvas ready.",
    "[Note] Waiting for a workflow — or ask the helper.",
  ]);

  // ── Undo history ────────────────────────────────────────────────────────
  // A snapshot is taken only for structural changes (a node or an edge appearing
  // or disappearing), plus Kimi renames. Dragging a card or typing in the name
  // field therefore cannot bury the useful history under keystrokes.
  const historyRef = React.useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const prevGraphRef = React.useRef<{ nodes: Node[]; edges: Edge[] }>({ nodes: initialNodes, edges: initialEdges });
  const suppressHistoryRef = React.useRef(false);
  const lastHandledRenameRef = React.useRef(0);

  // A rename from Kimi leaves the node count untouched, so it needs its own
  // signal rather than being inferred from the graph's shape. Kept as state
  // because this is the value the effect below watches.
  const [renameRequest, setRenameRequest] = React.useState(0);

  React.useEffect(() => {
    const previous = prevGraphRef.current;
    const structural = previous.nodes.length !== nodes.length || previous.edges.length !== edges.length;
    const labelEdit = renameRequest !== lastHandledRenameRef.current;

    if (suppressHistoryRef.current) {
      suppressHistoryRef.current = false;
    } else if (structural || labelEdit) {
      historyRef.current.push(previous);
      if (historyRef.current.length > 50) historyRef.current.shift();
      setCanUndo(historyRef.current.length > 0);
    }

    lastHandledRenameRef.current = renameRequest;
    prevGraphRef.current = { nodes, edges };
  }, [nodes, edges, renameRequest]);

  /** Close the floating add-node menu when clicking anywhere outside it. */
  React.useEffect(() => {
    if (!addMenuOpen) return undefined;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && target.closest("[data-add-menu]")) return;
      setAddMenuOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [addMenuOpen]);

  // Track if workflow has been loaded from persistent storage
  const workflowLoadedFromStorage = React.useRef(false);
  // The agent id whose saved graph is currently on the canvas. The load
  // effect must not re-fetch (and clobber the canvas) when router.replace
  // only adds that same id to the URL after a save.
  const loadedAgentIdRef = React.useRef<string | null>(null);
  // One save at a time: autosave and manual save share this lock so two
  // concurrent PATCHes cannot last-writer-win each other.
  const saveInFlightRef = React.useRef(false);
  // Input the Run button executes the workflow with (POST /api/execute).
  const [runInput, setRunInput] = React.useState("Run the workflow and summarise what each step did.");

  // ── Guest vs logged-in ───────────────────────────────────────────────
  // Whether this browser holds a signed-in user decides where saves go:
  // logged in → the server, exactly as before; a guest → this browser
  // only (localStorage, via the guest helper). `null` means not checked
  // yet. The answer lives in a ref (not state) so the 3s auto-save timer
  // — which runs outside a render — reads the latest answer without a
  // stale closure.
  const isLoggedInRef = React.useRef<boolean | null>(null);
  // True when the last save landed in this browser, so the header can say
  // "Saved in this browser" instead of "Saved".
  const [savedInBrowser, setSavedInBrowser] = React.useState(false);

  /** Ask the server whether this browser is signed in; caches the answer. */
  const checkLoggedIn = React.useCallback(async (): Promise<boolean> => {
    if (isLoggedInRef.current !== null) return isLoggedInRef.current;
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      const data = (await res.json().catch(() => ({}))) as { user?: unknown };
      const loggedIn = Boolean(data?.user);
      isLoggedInRef.current = loggedIn;
      return loggedIn;
    } catch {
      // Unreachable auth check: treat as a guest so no server save is
      // attempted, and the browser copy still keeps the work safe.
      isLoggedInRef.current = false;
      return false;
    }
  }, []);

  React.useEffect(() => {
    void checkLoggedIn();
  }, [checkLoggedIn]);

  React.useEffect(() => {
    const workflowFromQuery = searchParams?.get("workflow");
    const workflowFromSession = typeof window !== "undefined" ? window.sessionStorage.getItem("pendingWorkflow") : null;

    // Already showing this agent's saved graph, or the canvas has edits
    // newer than the last save: do not replace the canvas with a stale fetch.
    if (agentId && loadedAgentIdRef.current === agentId) return;
    if (agentId && loadedAgentIdRef.current && unsavedChanges.current) return;

    const loadWorkflow = (workflow: any) => {
      console.log("[LOAD] Loading workflow:", workflow);
      loadedAgentIdRef.current = agentId ?? null;
      const { nodes: mappedNodes, edges: mappedEdges } = mapWorkflowToCanvas(workflow);
      // The loaded graph becomes the new baseline: undo should not be able to
      // wipe it back to an empty canvas.
      historyRef.current = [];
      suppressHistoryRef.current = true;
      setCanUndo(false);
      setNodes(mappedNodes);
      setEdges(mappedEdges);
      workflowLoadedFromStorage.current = true;
      initialLoadDone.current = false; // Reset so auto-save will trigger after load
      setLogs((prev) => [...prev, "[Note] Workflow loaded."]);
    };

    if (workflowFromQuery) {
      try {
        const parsed = JSON.parse(workflowFromQuery);
        loadWorkflow(parsed);
        return;
      } catch (error) {
        console.error("[ERROR] Failed to parse workflow from query:", error);
      }
    }

    if (workflowFromSession) {
      try {
        const parsed = JSON.parse(workflowFromSession);
        loadWorkflow(parsed);
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem("pendingWorkflow");
        }
        return;
      } catch (error) {
        console.error("[ERROR] Failed to parse workflow from session:", error);
      }
    }

    // Guest handoff: no agent on the server, but the create page (or an
    // earlier builder visit) saved a workflow in this browser. Load that
    // copy with no account and no server round-trip. An agentId always wins
    // over the browser copy — the server copy is the saved one.
    if (!agentId) {
      const guest = readGuestWorkflow();
      if (guest?.workflow) {
        loadWorkflow(guest.workflow);
        setLogs((prev) => [...prev, "[Note] Loaded the workflow saved in this browser."]);
        return;
      }
    }

    if (!agentId) {
      setNodes([]);
      setEdges([]);
      workflowLoadedFromStorage.current = false;
      return;
    }

    console.log("[LOAD] Fetching agent:", agentId);
    fetch(`/api/agents/${agentId}`, {
      credentials: 'include',
    })
      .then((res) => res.json())
      .then((agent) => {
        console.log("[LOAD] Agent data:", agent);
        if (agent?.workflow) {
          loadWorkflow(agent.workflow);
          setLogs((prev) => [...prev, `[Note] Loaded the saved flow for ${agent.name}.`]);
        } else {
          console.log("[LOAD] No workflow found in agent");
          setNodes([]);
          setEdges([]);
          workflowLoadedFromStorage.current = true;
        }
      })
      .catch((err) => {
        console.error("[ERROR] Failed to load agent workflow:", err);
        setLogs((prev) => [...prev, "[Note] Couldn't load the saved workflow."]);
      });
  }, [agentId, searchParams, setNodes, setEdges]);

  // ── One payload builder for every save path ──────────────────────────
  // Autosave, manual Save Draft, and Deploy all send exactly this graph:
  // node config (model, system prompt, RAG index/topK, API URL, condition
  // expression), node positions, and edge labels. What the panel shows is
  // what gets saved, and what gets saved is what runs.
  const buildWorkflowPayload = () => {
    const draftName = (agentNameFromQuery || "Untitled Draft").trim() || "Untitled Draft";
    return {
      name: draftName,
      description: "Workflow saved from the visual builder.",
      nodes: nodes.map((node) => ({
        id: node.id,
        name: node.data?.label ?? "Untitled",
        // Registry nodes persist under their machine name (data.nodeType),
        // with the registry version, so loading them back restores the
        // same node instead of an LLM node.
        type: toPersistedType(node.data?.type, node.data?.nodeType as string | undefined),
        ...(typeof node.data?.registryVersion === "number"
          ? { version: node.data.registryVersion }
          : {}),
        description: node.data?.description ?? "",
        config: ((node.data?.config ?? {}) as Record<string, unknown>),
        position: { x: node.position.x, y: node.position.y },
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: typeof edge.label === "string" ? edge.label : undefined,
      })),
    };
  };

  /** Merge a config patch into the selected node's saved config. */
  const updateSelectedConfig = (patch: Record<string, unknown>) => {
    if (!selectedNode) return;
    const id = selectedNode.id;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, config: { ...((n.data?.config ?? {}) as Record<string, unknown>), ...patch } } }
          : n,
      ),
    );
  };

  /** The config of the selected node, as a plain object. */
  const selectedConfig = ((selectedNode?.data?.config ?? {}) as Record<string, unknown>);

  /**
   * The registry description of the selected node, if it is an automation
   * node. Legacy nodes carry no `nodeType` and keep their hand-built panel
   * below; registry nodes get the properties-driven panel instead.
   */
  const selectedRegistryDesc = React.useMemo(() => {
    const nodeType = selectedNode?.data?.nodeType;
    if (typeof nodeType !== "string" || !nodeType) return null;
    const version =
      typeof selectedNode?.data?.registryVersion === "number"
        ? selectedNode.data.registryVersion
        : defaultVersion(nodeType);
    return getNodeType(nodeType, version) ?? null;
  }, [selectedNode]);

  const visibleRegistryProperties = React.useMemo(
    () =>
      selectedRegistryDesc
        ? selectedRegistryDesc.properties.filter((prop) => isPropertyVisible(prop, selectedConfig))
        : [],
    // selectedConfig is a fresh object per render, so this re-runs every
    // render — intended: flipping an option must show/hide fields at once.
    [selectedRegistryDesc, selectedConfig],
  );

  // Advanced fields — raw code, JSON, and expressions — live behind one
  // "More options" disclosure per panel. They still work exactly as before;
  // they are only presented simply. Everything else stays in the open.
  const isAdvancedProperty = (prop: NodeProperty) =>
    prop.type === "json" ||
    prop.type === "collection" ||
    LONG_TEXT_PROPERTIES.has(prop.name) ||
    prop.name === "expression";
  const basicRegistryProperties = visibleRegistryProperties.filter((prop) => !isAdvancedProperty(prop));
  const advancedRegistryProperties = visibleRegistryProperties.filter(isAdvancedProperty);

  // ── Auto-save draft every 3s after changes ───────────────────────────
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  // Why the last save failed. Without this the only signal is a red "Save
  // Failed" badge plus a console line that names neither the endpoint nor the
  // server's reason.
  const [autoSaveError, setAutoSaveError] = React.useState<string | null>(null);
  const [lastSavedTime, setLastSavedTime] = React.useState<Date | null>(null);
  const initialLoadDone = React.useRef(false);
  const unsavedChanges = React.useRef(false);

  React.useEffect(() => {
    // Skip the very first render (initial load / workflow fetch)
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      console.log("[AUTO-SAVE] Initial load skipped, will save on next change");
      return;
    }

    // Only track changes after workflow has been loaded
    if (!workflowLoadedFromStorage.current && nodes.length === 0) {
      console.log("[AUTO-SAVE] No nodes and workflow not loaded yet, skipping save");
      return;
    }

    unsavedChanges.current = true;
    console.log("[AUTO-SAVE] Unsaved changes detected:", nodes.length, "nodes");

    const timer = setTimeout(async () => {
      if (saveInFlightRef.current) return;
      saveInFlightRef.current = true;
      setAutoSaveStatus("saving");
      // Computed outside `try` so a thrown request can still name what it was
      // talking to — a bare "Error:" tells you nothing about which call failed.
      const saveTarget = agentId ? `PATCH /api/agents/${agentId}` : "POST /api/agents";
      console.log("[AUTO-SAVE] Starting save...", { agentId, nodeCount: nodes.length, edgeCount: edges.length });
      try {
        // Guest: no account, so the 3s auto-save writes to this browser
        // instead of the server. A server save for a guest would fail with
        // "Log in to use this part." — that stays the answer for server
        // saves (Run / Make live), but an auto-save must never lose work
        // to a login wall.
        const loggedIn = isLoggedInRef.current ?? (await checkLoggedIn());
        if (!loggedIn) {
          const guestDraftName = (agentNameFromQuery || "Untitled Draft").trim() || "Untitled Draft";
          const stored = saveGuestWorkflow({
            workflow: buildWorkflowPayload(),
            name: guestDraftName,
            prompt: "",
          });
          if (stored) {
            setSavedInBrowser(true);
            setAutoSaveStatus("saved");
            setAutoSaveError(null);
            setLastSavedTime(new Date());
            unsavedChanges.current = false;
            // Reset to idle after 2s
            setTimeout(() => setAutoSaveStatus("idle"), 2000);
          } else {
            setAutoSaveError("Could not save in this browser — browser storage is full or blocked.");
            setAutoSaveStatus("error");
          }
          return;
        }
        setSavedInBrowser(false);
        const draftName = (agentNameFromQuery || "Untitled Draft").trim() || "Untitled Draft";
        const workflowPayload = buildWorkflowPayload();
        const endpoint = agentId ? `/api/agents/${agentId}` : "/api/agents";
        const method = agentId ? "PATCH" : "POST";
        const body = agentId
          ? // Deliberately no `name` on update. The builder has no name field, so
            // whatever the URL carries can be stale or belong to a different
            // agent — sending it would trip the "no two agents share a name"
            // guard, return 409, and block every future autosave. The stored
            // name stays the source of truth.
            { workflow: workflowPayload, status: "draft" }
          : {
              name: draftName,
              description: "Auto-saved draft from the visual builder.",
              prompt: "",
              workflow: workflowPayload,
              status: "draft",
              // The builder never asks for a name, so it accepts a numbered
              // variant instead of failing the save on a collision.
              autoName: true,
            };

        console.log("[AUTO-SAVE] Sending to", endpoint, "with", method);
        const res = await fetch(endpoint, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: 'include',
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          console.log("[AUTO-SAVE] Success! Saved agent:", data._id);
          // The canvas now matches this saved graph; the load effect must
          // not re-fetch it and clobber edits typed since the save started.
          if (data?._id) loadedAgentIdRef.current = data._id;
          else if (agentId) loadedAgentIdRef.current = agentId;
          // Update URL with agentId if this was a new save
          if (data?._id && !agentId && typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            params.set("agentId", data._id);
            params.set("agentName", data.name || draftName);
            router.replace(`${window.location.pathname}?${params.toString()}`);
          }
          setAutoSaveStatus("saved");
          setAutoSaveError(null);
          setLastSavedTime(new Date());
          unsavedChanges.current = false;
          // Reset to idle after 2s
          setTimeout(() => setAutoSaveStatus("idle"), 2000);
        } else {
          const raw = await res.text().catch(() => "");
          let reason = raw.slice(0, 400);
          if (raw.startsWith("{")) {
            try {
              const parsed = JSON.parse(raw) as { error?: unknown };
              if (typeof parsed.error === "string" && parsed.error) reason = parsed.error;
            } catch {
              reason = raw.slice(0, 400);
            }
          }
          if (!reason) reason = "empty response body";
          console.error(`[AUTO-SAVE] ${saveTarget} -> HTTP ${res.status} ${res.statusText}: ${reason}`);
          setAutoSaveError(`${saveTarget} returned ${res.status}: ${reason}`);
          setAutoSaveStatus("error");
          // The error stays until a later save succeeds — a user looking away
          // must not miss the only signal that their work is not saved.
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[AUTO-SAVE] ${saveTarget} threw: ${reason}`);
        setAutoSaveError(`${saveTarget} failed: ${reason}`);
        setAutoSaveStatus("error");
        // See above: the error stays until a later save succeeds.
      } finally {
        saveInFlightRef.current = false;
      }
    }, 3000); // 3 second debounce

    return () => clearTimeout(timer);
  }, [nodes, edges]);

  // ── Warn on unsaved changes before leaving ───────────────────────────
  React.useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsavedChanges.current && autoSaveStatus !== "saved") {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [autoSaveStatus]);

  // Handle flow connect
  const onConnect = React.useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  // Clicking empty canvas clears the selection. Only touch the array when
  // something is actually selected, so a stray click cannot trigger a save.
  const onPaneClick = React.useCallback(() => {
    setNodes((nds) =>
      nds.some((n) => n.selected) ? nds.map((n) => (n.selected ? { ...n, selected: false } : n)) : nds,
    );
  }, [setNodes]);

  // H17: the builder no longer records runs itself. POST /api/execute
  // already writes exactly one `workflow_runs` row on the server (graph,
  // item and no-graph paths alike), so the old recordRealRun POST after
  // every Run click wrote a second row for the same execution. Runs are
  // recorded by the server only — the builder just shows the result.
  // (Guest runs were never recorded either way: the guest engine writes
  // nothing server-side and this page posted nothing for guests.)

  /**
   * Plain connection line for a step in the step-by-step run record,
   * looked up by the step's name on the canvas (" · AI step · OpenRouter").
   * Display only — the record is text, so the mark itself cannot ride
   * along; the words carry the same information.
   */
  const stepRecordSuffix = (stepName: string) => {
    const node = nodes.find((n) => labelOf(n) === stepName);
    if (!node) return "";
    return ` · ${connectionForNode(typeOf(node), (node.data?.config ?? {}) as Record<string, unknown>).label}`;
  };

  /**
   * "Run" on the authoring canvas is two steps, in order. First the same
   * compile pass as before (catalogue, connections, entry/output, cycles).
   * Then — only if the graph compiles — a REAL execution: the canvas is
   * saved, then POST /api/execute runs the saved graph through the same
   * executor production uses, and the log shows per-node outputs, latency,
   * and the provider/model that actually answered. Nothing here is a
   * simulation: if no provider answers, the run fails and says so.
   */
  const handleRun = async () => {
    if (isRunning) return;
    setIsRunning(true);

    const startedAt = Date.now();
    setLogs((prev) => [
      ...prev,
      `[Check] Checking ${nodes.length} step(s) and ${edges.length} connection(s)...`,
    ]);

    const issues: string[] = [];
    // Registry (automation) nodes are known types too: their canvas type
    // is the description's display name, and a trigger node starts the
    // flow just as an Input Trigger does.
    const registryTypes = listNodeTypes();
    const registryDisplayNames = registryTypes.map((d) => d.displayName);
    const registryTriggerNames = new Set(
      registryTypes.filter((d) => d.group.includes("trigger")).map((d) => d.displayName),
    );
    const knownTypes = new Set([...NODE_CATALOG.map((entry) => entry.type), ...registryDisplayNames]);
    const nodeIds = new Set(nodes.map((node) => node.id));
    const linked = new Set<string>();

    if (nodes.length === 0) issues.push("the canvas is empty — add a step first");

    for (const edge of edges) {
      linked.add(edge.source);
      linked.add(edge.target);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        issues.push(`a connection points at a step that no longer exists`);
      }
    }

    const typeCounts = new Map<string, number>();
    for (const node of nodes) {
      const type = typeOf(node);
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

      if (!knownTypes.has(type)) {
        issues.push(`'${labelOf(node) || node.id}' has an unknown step type '${type}'`);
      }
      if (nodes.length > 1 && !linked.has(node.id)) {
        issues.push(`'${labelOf(node) || node.id}' is not connected to anything`);
      }
    }

    if (nodes.length > 0) {
      const hasStarter =
        typeCounts.has("Input") || registryDisplayNames.some((n) => registryTriggerNames.has(n) && typeCounts.has(n));
      if (!hasStarter) issues.push("nothing starts the flow — add a starting step (a Start step, or a link that starts it)");
      const hasFinisher = typeCounts.has("Output") || typeCounts.has("Respond To Webhook");
      if (!hasFinisher) issues.push("no final step — the flow never gives an answer");
    }

    // Branching needs labelled edges: the executor follows the edge whose
    // label matches the outcome ('true'/'false' for Condition and If, the
    // case value for Switch), and an unlabelled branch is a coin flip, so
    // flag it here.
    for (const node of nodes) {
      const nodeType = typeOf(node);
      if (nodeType !== "Condition" && nodeType !== "If" && nodeType !== "Switch") continue;
      const outgoing = edges.filter((e) => e.source === node.id);
      if (outgoing.length > 1 && outgoing.some((e) => !String(e.label ?? "").trim())) {
        issues.push(`'${labelOf(node) || node.id}' (Choice) has a connection out with no label — pick Yes or No for each way out`);
      }
    }

    // Kahn's algorithm: any node that never reaches indegree 0 sits on a cycle,
    // which would loop forever at execution time.
    const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
    const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
    let settled = 0;
    while (queue.length > 0) {
      const id = queue.shift() as string;
      settled += 1;
      for (const edge of edges) {
        if (edge.source !== id || !nodeIds.has(edge.target)) continue;
        const next = (indegree.get(edge.target) ?? 0) - 1;
        indegree.set(edge.target, next);
        if (next === 0) queue.push(edge.target);
      }
    }
    if (nodes.length > 0 && settled < nodeIds.size) issues.push("the steps loop back on themselves — a step can't lead back to an earlier one");

    const summary = issues.length === 0
      ? `Checked ${nodes.length} step(s) / ${edges.length} connection(s) — all good.`
      : `${issues.length} issue(s): ${issues.join("; ")}`;

    setLogs((prev) => [
      ...prev,
      ...(issues.length === 0
        ? [
            `[Check] ✓ Steps, connections, start, finish, and no loops all check out.`,
            `[Check] ✓ ${summary}`,
            "[Note] Nothing ran yet — open Try it out to run it for real.",
          ]
        : [
            ...issues.map((issue) => `[Check] ✗ ${issue}`),
            `[Note] Check finished with ${issues.length} issue(s). Nothing ran.`,
          ]),
    ]);

    if (issues.length > 0) {
      setIsRunning(false);      return;
    }

    // The graph compiles. Save it, then execute what is on the canvas —
    // never an older saved graph.
    const input = runInput.trim() || "Run the workflow.";
    if (!agentId) {
      // Guest Run: no account, so there is nothing to save — run the canvas
      // as-is, statelessly, through POST /api/execute with the workflow
      // itself. The step-by-step record renders exactly like a signed-in
      // run; guest runs are simply never written to past runs.
      setLogs((prev) => [...prev, `[Run] Running your workflow with: "${input.slice(0, 120)}${input.length > 120 ? "…" : ""}"`]);
      try {
        const execRes = await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ workflow: buildWorkflowPayload(), input }),
        });
        const execData = await execRes.json().catch(() => ({}));
        const elapsedMs = Date.now() - startedAt;
        const trace = Array.isArray(execData.trace) ? execData.trace : [];
        const allOk = execRes.ok && trace.every((step: { ok?: boolean }) => step.ok !== false);
        for (const step of trace) {
          setLogs((prev) => [
            ...prev,
            `[Run] ${step.ok ? "✓" : "✗"} [${step.name}]${stepRecordSuffix(step.name)} ${step.summary} (${step.durationMs ?? 0} ms)`,
          ]);
        }
        if (trace.length === 0) {
          setLogs((prev) => [...prev, `[Run] ${execRes.ok ? "✓" : "✗"} ${execData.error || "No step-by-step record came back."}`]);
        }
        const provider = execData.provider ?? null;
        const model = execData.model ?? null;
        const ragFailed = trace.some((step: { type?: string; ok?: boolean }) => step.type === "rag" && step.ok === false);
        setLogs((prev) => [
          ...prev,
          `[Run] ${allOk ? "✓" : "✗"} Finished in ${elapsedMs} ms${provider ? ` via ${provider}` : ""}${model ? ` (${model})` : ""}.`,
          ...(typeof execData.output === "string" && execData.output
            ? [`[Answer] ${execData.output.slice(0, 500)}${execData.output.length > 500 ? "…" : ""}`]
            : []),
          "[Note] Guest runs are not saved in past runs — log in to keep them.",
          ...(ragFailed ? ["[Note] Your files are not available as a guest — log in to add files and use the file-search step."] : []),
        ]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "network failure";
        setLogs((prev) => [...prev, `[Run] ✗ ${reason}`]);
      } finally {
        setIsRunning(false);
      }
      return;
    }
    setLogs((prev) => [...prev, `[Run] Saving your work, then running it with: "${input.slice(0, 120)}${input.length > 120 ? "…" : ""}"`]);
    const savedId = await saveDraftInternal();
    if (!savedId) {
      setLogs((prev) => [...prev, "[Run] ✗ Could not save the workflow, so nothing ran. Fix the save error above and try again."]);
      setIsRunning(false);
      return;
    }
    try {
      const execRes = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ agentId: savedId, input }),
      });
      const execData = await execRes.json().catch(() => ({}));
      const elapsedMs = Date.now() - startedAt;
      const trace = Array.isArray(execData.trace) ? execData.trace : [];
      const allOk = execRes.ok && trace.every((step: { ok?: boolean }) => step.ok !== false);
      for (const step of trace) {
        setLogs((prev) => [
          ...prev,
          `[Run] ${step.ok ? "✓" : "✗"} [${step.name}]${stepRecordSuffix(step.name)} ${step.summary} (${step.durationMs ?? 0} ms)`,
        ]);
      }
      if (trace.length === 0) {
        setLogs((prev) => [...prev, `[Run] ${execRes.ok ? "✓" : "✗"} ${execData.error || "No step-by-step record came back."}`]);
      }
      const provider = execData.provider ?? null;
      const model = execData.model ?? null;
      setLogs((prev) => [
        ...prev,
        `[Run] ${allOk ? "✓" : "✗"} Finished in ${elapsedMs} ms${provider ? ` via ${provider}` : ""}${model ? ` (${model})` : ""}.`,
        ...(typeof execData.output === "string" && execData.output
          ? [`[Answer] ${execData.output.slice(0, 500)}${execData.output.length > 500 ? "…" : ""}`]
          : []),
      ]);
      // H17: no client-side record — POST /api/execute already wrote the
      // one `workflow_runs` row for this run on the server.
    } catch (err) {
      const reason = err instanceof Error ? err.message : "network failure";
      setLogs((prev) => [...prev, `[Run] ✗ ${reason}`]);
      // H17: a failed fetch never reached the server, so no execution
      // happened and no row is recorded. (The old code posted a "failed"
      // row here for a run that never ran.)
    } finally {
      setIsRunning(false);
    }
  };

  /**
   * Deploy saves the canvas first, then activates. Deploying the last-saved
   * graph while the canvas held newer edits used to ship stale work; the
   * deployed graph is now exactly what is on screen. A failed save aborts
   * the deploy — nothing is activated.
   */
  const handleDeploy = async () => {
    setSaveBusy(true);
    try {
      const savedId = await saveDraftInternal();
      if (!savedId) {
        setLogs((prev) => [...prev, "[Live] ✗ Save failed, so nothing went live. Fix the save error and try again."]);
        return;
      }
      const res = await fetch(`/api/agents/${savedId}`, {        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: "active" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setLogs((prev) => [
        ...prev,
        "[Live] Saved, then switched on.",
        "[Live] It is now live and can be called from outside.",
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "deploy failed";
      setLogs((prev) => [...prev, `[Live] ✗ ${reason}`]);
    } finally {
      setSaveBusy(false);
    }
  };

  /**
   * Everything the assistant needs to reason about the canvas right now.
   * Reads component state only — no refs — so it stays safe to hand to handlers.
   */
  const graphSnapshot = () => ({
    nodes,
    edges,
    selectedId: selectedNode?.id ?? null,
    // The engine only needs to know whether "undo" is a real option.
    historyDepth: canUndo ? 1 : 0,
  });

  /** Add a node of `type`, on a free grid slot with a unique id and title. */
  const handleAddNode = (type: string) => {
    const graph = graphSnapshot();
    const actions = planAddNode(graph, { type, layout: isNarrowViewport() ? "column" : "grid" });
    const next = applyActions(graph, actions);
    const created = actions.find((a) => a.kind === "add-node");
    const title = created && created.kind === "add-node" ? labelOf(created.node) : type;

    setNodes(next.nodes);
    setEdges(next.edges);
    setFitToken((t) => t + 1);
    setFitMode("latest");
    setLogs((prev) => [...prev, `[Note] Added step '${title}' to the canvas.`]);
  };

  /**
   * Add a registry (automation) node of the given description. Its config
   * starts as the description's property defaults, so the node is runnable
   * as placed and the settings panel shows real values from the first click.
   * The machine name rides on `data.nodeType` (with its version) so the
   * properties panel and the executor can resolve the description; `data.type`
   * carries the display name the canvas card shows.
   */
  const handleAddRegistryNode = (desc: NodeDescription) => {
    const config: Record<string, unknown> = {};
    for (const prop of desc.properties) config[prop.name] = prop.default;
    const label = uniqueLabel(nodes, desc.displayName);
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "node";
    let counter = nodes.length + 1;
    let id = `n_${slug}_${counter}`;
    while (nodes.some((n) => n.id === id)) {
      counter += 1;
      id = `n_${slug}_${counter}`;
    }
    const node: Node = {
      id,
      type: "customNode",
      position: findFreeSlot(nodes, undefined, isNarrowViewport() ? 1 : 4),
      data: {
        label,
        type: desc.displayName,
        description: desc.description ?? "",
        config,
        nodeType: desc.name,
        registryVersion: desc.version,
      },
    };
    setNodes((nds) => [...nds, node]);
    setFitToken((t) => t + 1);
    setFitMode("latest");
    setLogs((prev) => [...prev, `[Note] Added step '${label}' to the canvas.`]);
  };

  /**
   * Delete whatever is selected: nodes (React Flow drops their edges too) or
   * loose connections. Shared by the canvas toolbar and the panel's Remove Node
   * button so there is one deletion path.
   */
  const handleDeleteSelection = () => {
    if (selectedNodes.length > 0) {
      const ids = new Set(selectedNodes.map((n) => n.id));
      const titles = selectedNodes.map((n) => `'${labelOf(n) || "(untitled)"}'`).join(", ");
      const lost = edges.filter((e) => ids.has(e.source) || ids.has(e.target)).length;

      setNodes((nds) => nds.filter((n) => !ids.has(n.id)));
      setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
      setLogs((prev) => [
        ...prev,
        `[Note] Removed ${titles}${lost ? ` and ${lost} connection${lost === 1 ? "" : "s"}` : ""}.`,
      ]);
      return;
    }

    if (selectedEdges.length > 0) {
      const ids = new Set(selectedEdges.map((e) => e.id));
      setEdges((eds) => eds.filter((e) => !ids.has(e.id)));
      setLogs((prev) => [...prev, `[Note] Removed ${ids.size} connection${ids.size === 1 ? "" : "s"}.`]);
    }
  };

  /** Step back to the graph as it was before the last structural edit. */
  const handleUndo = () => {
    const previous = historyRef.current[historyRef.current.length - 1];
    if (!previous) return;

    const unchanged = previous.nodes === nodes && previous.edges === edges;
    historyRef.current.pop();
    setCanUndo(historyRef.current.length > 0);
    if (unchanged) return;

    suppressHistoryRef.current = true;
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setLogs((prev) => [...prev, "[Note] Undid the last change."]);
  };

  /**
   * The one save implementation. Returns the agent id on success, null on
   * failure. Used by Save Draft, by Run (execute the saved canvas), and by
   * Deploy (save first, then activate) — so all three always save the same
   * graph. Shares the autosave lock and sends credentials like autosave does.
   */
  const saveDraftInternal = async (): Promise<string | null> => {
    if (saveInFlightRef.current) {
      // A save is already running; wait for it instead of firing a second one.
      for (let i = 0; i < 50 && saveInFlightRef.current; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (saveInFlightRef.current) return null;
    }
    saveInFlightRef.current = true;
    const draftName = (agentNameFromQuery || "Untitled Draft").trim() || "Untitled Draft";
    try {
      const workflowPayload = buildWorkflowPayload();
      const endpoint = agentId ? `/api/agents/${agentId}` : "/api/agents";
      const method = agentId ? "PATCH" : "POST";
      const body = agentId
        ? {
            // No `name` here either — see the autosave. Renaming is not what a
            // "Save draft" button is for, and sending a name we never displayed
            // could collide with another agent and fail the save.
            workflow: workflowPayload,
            status: "draft",
          }
        : {
            name: draftName,
            description: "Saved draft from the visual builder.",
            prompt: "",
            workflow: workflowPayload,
            status: "draft",
            autoName: true,
          };

      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to save draft.");

      const savedId = (data?._id as string | undefined) ?? agentId ?? null;
      if (savedId) loadedAgentIdRef.current = savedId;
      if (data?._id && typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        params.set("agentId", data._id);
        params.set("agentName", data.name || draftName);
        router.replace(`${window.location.pathname}?${params.toString()}`);
      }

      setAutoSaveStatus("saved");
      setAutoSaveError(null);
      setLastSavedTime(new Date());
      unsavedChanges.current = false;
      setTimeout(() => setAutoSaveStatus("idle"), 2000);
      return savedId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to save draft.";
      setAutoSaveStatus("error");
      setAutoSaveError(msg);
      throw error;
    } finally {
      saveInFlightRef.current = false;
    }
  };

  const handleSaveDraft = async () => {
    setSaveBusy(true);
    setSaveMessage(null);
    try {
      // Guest: Save writes to this browser, in plain words. The server save
      // below stays login-only — a guest asking the server to save still gets
      // its plain "Log in to use this part." answer (Run / Make live go
      // through saveDraftInternal and keep that behaviour).
      if (!(isLoggedInRef.current ?? (await checkLoggedIn()))) {
        const draftName = (agentNameFromQuery || "Untitled Draft").trim() || "Untitled Draft";
        const stored = saveGuestWorkflow({
          workflow: buildWorkflowPayload(),
          name: draftName,
          prompt: "",
        });
        if (!stored) throw new Error("Could not save in this browser — browser storage is full or blocked.");
        setSavedInBrowser(true);
        setAutoSaveStatus("saved");
        setAutoSaveError(null);
        setLastSavedTime(new Date());
        unsavedChanges.current = false;
        setTimeout(() => setAutoSaveStatus("idle"), 2000);
        setSaveMessage("Saved in this browser.");
        setLogs((prev) => [...prev, "[Note] Saved in this browser."]);
        return;
      }
      const savedId = await saveDraftInternal();
      if (!savedId) throw new Error("Save is already in progress — try again in a moment.");
      setSaveMessage("Draft saved.");
      setLogs((prev) => [...prev, "[Note] Draft saved."]);
      router.refresh();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to save draft.";
      setSaveMessage(msg);
      setLogs((prev) => [...prev, `[Note] ${msg}`]);
    } finally {
      setSaveBusy(false);
    }
  };

  /**
   * Ask the deterministic engine what this prompt means, then apply whatever it
   * comes back with. The engine never guesses: if a reference resolves to zero
   * or several nodes it says so and returns no actions, which is what keeps the
   * canvas from drifting every time the prompt is something it didn't expect.
   */
  const submitPrompt = (raw: string) => {
    const promptText = raw.trim();
    if (!promptText) return;

    setAssistantMessages((prev) => [...prev, { role: "user", content: promptText }]);
    setAssistantInput("");

    const graph = graphSnapshot();
    const result = runKimiCommand(promptText, graph, { layout: isNarrowViewport() ? "column" : "grid" });
    const firstLine = result.reply.split("\n")[0];
    setLogs((prev) => [...prev, `[Helper] ${firstLine}`]);

    const wantsUndo = result.actions.some((a) => a.kind === "undo");
    if (wantsUndo) {
      handleUndo();
    } else if (result.actions.length > 0) {
      // A rename leaves the node count alone, so tell the history effect about
      // it explicitly; structural edits are picked up automatically.
      if (result.actions.some((a) => a.kind === "rename-node")) setRenameRequest((n) => n + 1);

      const next = applyActions(graph, result.actions);
      const grew = next.nodes.length > graph.nodes.length;
      setNodes(next.nodes);
      setEdges(next.edges);
      if (grew) {
        setFitToken((t) => t + 1);
        setFitMode("latest");
      }
    }

    setAssistantMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
  };

  const handleAssistantSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submitPrompt(assistantInput);
  };

  const generateFromDescription = async (event: React.FormEvent) => {
    event.preventDefault();
    const prompt = generateInput.trim();
    if (!prompt || generating) return;
    setGenerating(true);
    setLogs((prev) => [...prev, `[Helper] Building a workflow for: ${prompt}`]);
    try {
      const res = await fetch('/api/agents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const workflow = data.workflow || data;
      const mapped = mapWorkflowToCanvas(workflow);
      setNodes(mapped.nodes);
      setEdges(mapped.edges);
      setFitToken((t) => t + 1);
      setFitMode("first");
      setLogs((prev) => [...prev, `[Helper] Built a workflow with ${mapped.nodes.length} step(s) and ${mapped.edges.length} connection(s).`]);
      setAssistantMessages((prev) => [...prev, { role: 'assistant', content: `Built from your description. You can change it with the helper or by dragging steps yourself.` }]);
      setGenerateInput('');
    } catch (err) {
      setLogs((prev) => [...prev, `[Helper] Couldn't build it: ${err instanceof Error ? err.message : 'unknown error'}`]);
    } finally {
      setGenerating(false);
    }
  };

  /** Quick-command chip. The prompt rides on the element so this stays a named
   *  handler rather than a fresh closure per item. */
  const handleQuickCommand = (event: React.MouseEvent<HTMLButtonElement>) => {
    const prompt = event.currentTarget.getAttribute("data-prompt");
    if (prompt) submitPrompt(prompt);
  };

  // Render left library. Two disclosures, each a real <button> with
  // aria-expanded, so the headers actually open and close. The plain
  // list starts open and owns the scroll space; the automatic list
  // starts closed behind "More steps" and, when opened, shares the
  // space as a second scroll area (flex-1 min-h-0) instead of a
  // content-sized block — the old layout let that block take all the
  // height and crush the plain list to a 32px strip.
  const renderLeftPanel = () => (
    <div className="flex-1 flex flex-col min-h-0 text-left select-none">
      <button
        type="button"
        onClick={() => setStepsOpen((open) => !open)}
        aria-expanded={stepsOpen}
        className="p-4 border-b border-[var(--border)] flex items-center justify-between w-full text-left hover:bg-[var(--row-hover)] transition-colors"
      >
        <span className="text-xs font-bold text-[var(--text)] uppercase tracking-wide">Steps to add</span>
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-muted">{NODE_CATALOG.length} kinds of step</span>
          <ChevronDown className={`icon-xs shrink-0 text-muted transition-transform ${stepsOpen ? "rotate-180" : ""}`} />
        </span>
      </button>
      {stepsOpen && (
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {NODE_CATALOG.map((node) => {
            return (
              <div
                key={node.type}
                role="button"
                tabIndex={0}
                onClick={() => handleAddNode(node.type)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleAddNode(node.type);
                  }
                }}
                aria-label={`Add ${node.label} step`}
                className="ruled-row flex cursor-pointer gap-3 px-1 py-3 select-none group"
              >
                <TypeIconTile type={node.type} />
                <div className="flex flex-col text-left min-w-0">
                  <span className="text-xs font-semibold text-[var(--text)] group-hover:text-[var(--accent)] transition-colors">
                    {node.label}
                  </span>
                  <span className="font-mono text-[8px] text-muted tracking-wide uppercase mt-0.5">
                    {connectionForNode(node.type).label}
                  </span>
                  <span className="text-[9px] text-muted mt-1 leading-relaxed">
                    {node.description}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div
        className={`border-t border-[var(--border)] flex flex-col min-h-0 ${
          moreStepsOpen ? "flex-1" : "shrink-0"
        }`}
      >
        <button
          type="button"
          onClick={() => setMoreStepsOpen((open) => !open)}
          aria-expanded={moreStepsOpen}
          className="p-4 flex items-center justify-between w-full text-left hover:bg-[var(--row-hover)] transition-colors"
        >
          <span className="text-xs font-bold text-[var(--text)] uppercase tracking-wide">More steps</span>
          <span className="flex items-center gap-2">
            <span className="text-[10px] text-muted">{listNodeTypes().length} kinds of step</span>
            <ChevronDown className={`icon-xs shrink-0 text-muted transition-transform ${moreStepsOpen ? "rotate-180" : ""}`} />
          </span>
        </button>
        {moreStepsOpen && (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-4">
            <p className="text-[10px] font-semibold text-muted uppercase tracking-wider">Automatic steps</p>
            {REGISTRY_GROUP_ORDER.map(({ group, heading }) => {
              const entries = listNodeTypes(group);
              if (entries.length === 0) return null;
              return (
                <div key={group} className="space-y-1.5">
                  <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">{heading}</span>
                  {entries.map((desc) => (
                    <div
                      key={desc.name}
                      role="button"
                      tabIndex={0}
                      onClick={() => handleAddRegistryNode(desc)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleAddRegistryNode(desc);
                        }
                      }}
                      aria-label={`Add ${plainKindName(desc.displayName)}`}
                      className="ruled-row flex cursor-pointer gap-3 px-1 py-3 select-none group"
                    >
                      <TypeIconTile type={desc.displayName} />
                      <div className="flex flex-col text-left min-w-0">
                        <span className="text-xs font-semibold text-[var(--text)] group-hover:text-[var(--accent)] transition-colors">
                          {plainKindName(desc.displayName)}
                        </span>
                        <span className="font-mono text-[8px] text-muted tracking-wide uppercase mt-0.5">
                          {connectionForNode(desc.displayName).label}
                        </span>
                        <span className="text-[9px] text-muted mt-1 leading-relaxed">
                          {desc.description ?? ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
            <p className="mt-3 text-[10px] text-muted leading-relaxed">
              These steps run on their own as part of your flow. Pick one on the canvas to change its settings.
            </p>
          </div>
        )}
      </div>
    </div>
  );

  // Render right properties editor
  const renderRightPanel = () => (
    <div className="flex-grow flex flex-col min-h-0 text-left select-none">
      <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
        <span className="text-xs font-bold text-[var(--text)] uppercase tracking-wide">Helper</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="notice">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
            Live editing
          </div>
          <p className="mt-2 text-[10px] text-muted leading-relaxed">
            I read what is on the canvas and change it directly — add, remove, rename, connect or undo. If I
            cannot tell which step you mean, I say so instead of guessing.
          </p>
        </div>

        <form onSubmit={generateFromDescription} className="space-y-2">
          <textarea
            value={generateInput}
            onChange={(e) => setGenerateInput(e.target.value)}
            placeholder="Describe what you want it to do, in your own words"
            className="textarea min-h-20 w-full text-xs"
          />
          <Button type="submit" size="sm" className="w-full" disabled={generating}>
            <Bot className="mr-1.5 icon-xs" />
            {generating ? 'Building...' : 'Build it for me'}
          </Button>
        </form>

        <form onSubmit={handleAssistantSubmit} className="space-y-2">
          <textarea
            value={assistantInput}
            onChange={(e) => setAssistantInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter keeps the newline.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="e.g. add a files step and connect it to the start"
            className="textarea min-h-24 w-full text-xs"
          />
          <Button type="submit" size="sm" className="w-full">
            <Send className="mr-1.5 icon-xs" />
            Send
          </Button>
        </form>

        <div className="space-y-1.5">
          <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Try</span>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_COMMANDS.map((command) => (
              <button
                key={command}
                type="button"
                data-prompt={command}
                onClick={handleQuickCommand}
                className="rounded-[2px] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px] text-muted transition-colors hover:border-[var(--border-strong)] hover:text-[var(--accent)]"
              >
                {command}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {assistantMessages.map((msg, index) => (
            <div key={`${msg.role}-${index}`} className={`rounded-[2px] border px-3 py-2 text-[10px] leading-relaxed ${msg.role === "assistant" ? "border-[var(--border)] border-l-[3px] border-l-[var(--accent)] bg-[var(--surface)] text-[var(--text)]" : "border-[var(--border)] bg-[var(--surface-2)] text-muted"}`}>
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider opacity-70">{msg.role === "assistant" ? "Helper" : "You"}</div>
              <div className="whitespace-pre-line">{msg.content}</div>
            </div>
          ))}
        </div>

        <div className="border-t border-[var(--border)] pt-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--text)] uppercase tracking-wide">Step settings</span>
          </div>
          {selectedNode ? (
            <div className="space-y-3.5">
              {/* Which app this step involves, at a glance. */}
              <div className="flex items-center gap-2.5 rounded-[2px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
                <TypeIconTile type={selectedNode.data.type} config={selectedConfig} selected />
                <div className="flex flex-col text-left min-w-0">
                  <span className="text-xs font-semibold text-[var(--text)] truncate">{selectedNode.data.label}</span>
                  <span className="font-mono text-[8px] text-muted tracking-wide uppercase mt-0.5">
                    {connectionForNode(selectedNode.data.type, selectedConfig).label}
                  </span>
                </div>
              </div>
              <Input
                label="Step name"
                value={selectedNode.data.label}
                onChange={(e) => {
                  const val = e.target.value;
                  setNodes((nds) =>
                    nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, label: val } } : n))
                  );
                }}
              />
              <Input
                label="What this step does"
                value={selectedNode.data.description}
                onChange={(e) => {
                  const val = e.target.value;
                  setNodes((nds) =>
                    nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, description: val } } : n))
                  );
                }}
              />

              {selectedNode.data.type === "LLM Node" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Model</label>
                    <select
                      value={typeof selectedConfig.model === "string" ? selectedConfig.model : ""}
                      onChange={(e) => updateSelectedConfig({ model: e.target.value || undefined })}
                      className="select w-full text-xs"
                    >
                      <option value="">Default (first configured provider)</option>
                      <option value="openai/gpt-4o">GPT-4o — OpenRouter</option>
                      <option value="moonshotai/kimi-k3.1-pro">Kimi K3.1 Pro — NVIDIA</option>
                      <option value="moonshotai/Kimi-K3">Kimi K3 — Hugging Face</option>
                      <option value="moonshot-v1-8k">Moonshot v1 8k — Moonshot Direct</option>
                    </select>
                    <p className="text-[10px] text-muted">Only models already set up here are listed. A step with no model set up fails the run instead of quietly using a different one.</p>
                    {(() => {
                      const provider = providerForModel(selectedConfig.model);
                      return (
                        <p className="flex items-center gap-1.5 text-[10px] text-muted">
                          <AppMark
                            markKey={provider ? provider.key : "ai"}
                            className="icon-xs shrink-0 text-[var(--accent)]"
                          />
                          {provider
                            ? `This step asks ${provider.label} to answer.`
                            : "No model picked yet — the step uses the first provider set up here."}
                        </p>
                      );
                    })()}
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">System Prompt</label>
                    <textarea
                      value={typeof selectedConfig.systemPrompt === "string" ? selectedConfig.systemPrompt : ""}
                      onChange={(e) => updateSelectedConfig({ systemPrompt: e.target.value })}
                      placeholder="You are a helpful assistant..."
                      className="textarea h-24 w-full text-xs"
                    />
                  </div>
                </div>
              )}

              {selectedNode.data.type === "RAG Node" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Your files</label>
                    <select
                      value={typeof selectedConfig.ragIndex === "string" ? selectedConfig.ragIndex : "default"}
                      onChange={(e) => updateSelectedConfig({ ragIndex: e.target.value })}
                      className="select w-full text-xs"
                    >
                      <option value="default">All your files</option>
                    </select>
                    <p className="text-[10px] text-muted">Everything you have uploaded is searched.</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">How many file passages to use</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={typeof selectedConfig.topK === "number" ? selectedConfig.topK : 3}
                      onChange={(e) => updateSelectedConfig({ topK: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 3))) })}
                      className="input w-full text-xs"
                    />
                  </div>
                </div>
              )}

              {selectedNode.data.type === "API Node" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Web address</label>
                    <input
                      type="url"
                      value={typeof selectedConfig.url === "string" ? selectedConfig.url : ""}
                      onChange={(e) => updateSelectedConfig({ url: e.target.value })}
                      placeholder="https://api.example.com/data"
                      className="input w-full text-xs"
                    />
                    <p className="text-[10px] text-muted">Only public web addresses are used. Private or local addresses are blocked.</p>
                  </div>
                </div>
              )}

              {selectedNode.data.type === "Condition" && (
                <details className="rounded-[2px] border border-[var(--border)] px-3 py-2">
                  <summary className="cursor-pointer text-[11px] font-semibold text-[var(--text)]">
                    More options
                  </summary>
                  <div className="space-y-1.5 pt-3">
                    <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">Rule, in code</label>
                    <input
                      type="text"
                      value={typeof selectedConfig.expression === "string" ? selectedConfig.expression : ""}
                      onChange={(e) => updateSelectedConfig({ expression: e.target.value })}
                      placeholder="state.includes('yes')"
                      className="input w-full text-xs"
                    />
                    <p className="text-[10px] text-muted">Checked against the current text. The flow follows the connection labelled Yes or No. Leave empty to always take the Yes way. Advanced — most flows don&apos;t need this.</p>
                  </div>
                </details>
              )}

              {selectedRegistryDesc && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">
                      {selectedRegistryDesc.displayName} settings
                    </span>
                    <p className="text-[10px] text-muted">
                      These fields come from the node itself. What you set here is saved with the node and used when the workflow runs.
                    </p>
                  </div>
                  {visibleRegistryProperties.length === 0 ? (
                    <p className="text-[10px] text-muted">
                      This step needs no settings — place it and connect it.
                    </p>
                  ) : (
                    <>
                      {basicRegistryProperties.map((prop) => (
                        <RegistryPropertyField
                          key={prop.name}
                          prop={prop}
                          value={selectedConfig[prop.name] ?? prop.default}
                          onChange={(next) => updateSelectedConfig({ [prop.name]: next })}
                        />
                      ))}
                      {advancedRegistryProperties.length > 0 && (
                        <details className="rounded-[2px] border border-[var(--border)] px-3 py-2">
                          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--text)]">
                            More options
                          </summary>
                          <div className="space-y-4 pt-3">
                            <p className="text-[10px] text-muted">
                              Advanced. These fields hold code or structured text — most flows don&apos;t need them.
                            </p>
                            {advancedRegistryProperties.map((prop) => (
                              <RegistryPropertyField
                                key={prop.name}
                                prop={prop}
                                value={selectedConfig[prop.name] ?? prop.default}
                                onChange={(next) => updateSelectedConfig({ [prop.name]: next })}
                              />
                            ))}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                  {selectedRegistryDesc.credentials && selectedRegistryDesc.credentials.length > 0 && (
                    <p className="text-[10px] text-muted">
                      Needs {selectedRegistryDesc.credentials.map((c) => c.name).join(", ")} — pick it in the Sign-in field above.
                    </p>
                  )}
                </div>
              )}

              <Button variant="danger" size="sm" className="w-full text-xs font-semibold" onClick={handleDeleteSelection}>
                <Trash2 className="icon-xs mr-1.5" />
                Remove {selectedNodes.length > 1 ? `${selectedNodes.length} steps` : "step"}
              </Button>
            </div>
          ) : (
            <div className="border-y border-[var(--border)] py-8 text-center text-xs text-muted">
              Pick a step on the canvas to change its settings.
            </div>
          )}
              {/* Edge labels for Condition branching */}
              {selectedEdges.length > 0 && (
                <div className="space-y-4 border-t border-[var(--border)] pt-4">
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">Which way to go</span>
                    {(() => {
                      const edge = selectedEdges[0];
                      const sourceNode = nodes.find((n) => n.id === edge.source);
                      const isCondition = sourceNode?.data?.type === "Condition";
                      if (!isCondition) {
                        return <p className="text-[10px] text-muted">This connection comes from a {plainKindName(sourceNode?.data?.type) || "step"} — labels only steer Choice steps.</p>;
                      }
                      return (
                        <>
                          <select
                            value={typeof edge.label === "string" ? edge.label : ""}
                            onChange={(e) => {
                              const label = e.target.value || undefined;
                              setEdges((eds) => eds.map((ed) => (ed.id === edge.id ? { ...ed, label } : ed)));
                            }}
                            className="select w-full text-xs"
                          >
                            <option value="">No label (don&apos;t use for a choice)</option>
                            <option value="true">Yes — follow when the rule is true</option>
                            <option value="false">No — follow when the rule is false</option>
                          </select>
                          <p className="text-[10px] text-muted">The flow follows the connection whose label matches the result.</p>
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Run input: what Run executes the workflow with */}
              <div className="space-y-1.5 border-t border-[var(--border)] pt-4">
                <label className="text-[10px] font-semibold text-muted uppercase tracking-wider">What to run it with</label>
                <textarea
                  value={runInput}
                  onChange={(e) => setRunInput(e.target.value)}
                  placeholder="What should this workflow do?"
                  className="textarea h-16 w-full text-xs"
                />
                <p className="text-[10px] text-muted">Run saves your work first, then runs it for real.</p>
              </div>

        </div>
      </div>
    </div>
  );

  // Render bottom log panel
  const renderBottomLogs = () => (
    <div className="h-full px-4 py-2 font-mono text-[11px] text-muted flex flex-col text-left select-text">
      {logs.map((log, i) => {
        let color = "text-muted";
        if (log.includes("[Note]")) color = "text-[var(--accent)] font-semibold";
        if (log.includes("[EXECUTION]")) color = "text-[var(--text)]";
        return (
          <div key={i} className={`border-b border-[var(--border)] py-1 ${color}`}>
            {log}
          </div>
        );
      })}
    </div>
  );

  return (
    <BuilderLayout
      title="Workflow builder"
      subtitle="Add steps, connect them in order, then press Run."
      leftPanel={renderLeftPanel()}
      rightPanel={renderRightPanel()}
      bottomLogs={renderBottomLogs()}
      onRun={handleRun}
      isRunning={isRunning}
      onSave={handleSaveDraft}
      isSaving={saveBusy}
      onDeploy={handleDeploy}
      sandboxHref={
        agentId
          ? `/testing-sandbox?agentId=${encodeURIComponent(agentId)}&name=${encodeURIComponent(agentNameFromQuery || "Workflow builder")}`
          : "/testing-sandbox"
      }
      autoSaveStatus={autoSaveStatus}
      savedInBrowser={savedInBrowser}
      autoSaveError={autoSaveError}
      lastSavedTime={lastSavedTime}
    >
      <div className="relative h-full w-full">
        <style>{`
          .react-flow__background circle { fill: var(--border); }
          .react-flow__edge-textbg { fill: var(--surface); }
          .react-flow__edge-text { fill: var(--muted); font-family: var(--font-mono); }
          .react-flow__minimap { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; }
          .react-flow__minimap-node { fill: var(--border-strong); stroke: var(--border-strong); }
          .react-flow__minimap-node.selected { fill: var(--accent); stroke: var(--accent); }
        `}</style>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onPaneClick={onPaneClick}
          // Guarded by React Flow against keystrokes typed into inputs, so
          // Backspace still edits text in the properties panel.
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          // The first fit fires when the first step gets its size; cap it
          // at 1x so a one-step canvas never blows up to 2x (see AutoFit).
          fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
          // H15: on a phone the 0.5 default floor stops a whole-graph fit
          // short and clips the end nodes; 0.1 lets it frame everything.
          minZoom={isNarrowCanvas ? 0.1 : 0.5}
        >
          <MiniMap
            nodeBorderRadius={2}
            maskColor="rgb(24 33 48 / 0.12)"
            className="hidden sm:block"
          />
          <Controls />
          <Background gap={16} />
          <AutoFit token={fitToken} mode={fitMode} />
          <NarrowInitialFit />
          <RefitAfterPanelsOpen />
        </ReactFlow>

        {/* Canvas toolbar — add, delete and undo without leaving the graph. */}
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-2">
          <div data-add-menu className="pointer-events-auto relative">
            <button
              type="button"
              onClick={() => setAddMenuOpen((open) => !open)}
              aria-expanded={addMenuOpen}
              aria-haspopup="menu"
              className="flex items-center gap-1.5 rounded-[2px] border border-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-[11px] font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--row-hover)]"
            >
              <Plus className="icon-xs" />
              Add step
              <ChevronDown className={`h-3 w-3 transition-transform ${addMenuOpen ? "rotate-180" : ""}`} />
            </button>

            {addMenuOpen && (
              <div
                role="menu"
                className="absolute left-0 top-full z-20 mt-2 w-56 overflow-hidden rounded-[4px] border border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow-pop)]"
              >
                {NODE_CATALOG.map((entry) => {
                  return (
                    <button
                      key={entry.type}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddMenuOpen(false);
                        handleAddNode(entry.type);
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--accent)]"
                    >
                      <TypeIcon type={entry.type} className="icon-xs shrink-0 text-accent" />
                      <span className="flex-1">{entry.label}</span>
                    </button>
                  );
                })}
                <div className="border-t border-[var(--border)] px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted">
                  Automatic steps
                </div>
                {listNodeTypes().map((desc) => (
                  <button
                    key={desc.name}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false);
                      handleAddRegistryNode(desc);
                    }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--row-hover)] hover:text-[var(--accent)]"
                  >
                    <TypeIcon type={desc.displayName} className="icon-xs shrink-0 text-accent" />
                    <span className="flex-1">{desc.displayName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleDeleteSelection}
            disabled={!hasSelection}
            title={hasSelection ? `Delete ${selectedNodes.length + selectedEdges.length} selected` : "Select a step or a connection first"}
            className="pointer-events-auto flex items-center gap-1.5 rounded-[2px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] font-semibold text-muted transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-muted"
          >
            <Trash2 className="icon-xs" />
            Delete
            {hasSelection && (
              <span className="rounded-[2px] bg-[var(--surface-2)] px-1 font-mono text-[9px] text-[var(--text)]">
                {selectedNodes.length + selectedEdges.length}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={handleUndo}
            disabled={!canUndo}
            title={canUndo ? "Undo the last change" : "Nothing to undo yet"}
            className="pointer-events-auto flex items-center gap-1.5 rounded-[2px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] font-semibold text-muted transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:text-muted"
          >
            <Undo2 className="icon-xs" />
            Undo
          </button>
        </div>

        {nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
            <div className="panel max-w-md px-6 py-5 text-center">
              <p className="text-sm font-semibold text-[var(--text)]">Start with one step</p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Press Add step above, pick a step to add, or ask the helper to build the flow for you.
                Then connect the steps in order and press Run.
              </p>
              <p className="mt-4 text-[10px] font-semibold text-muted uppercase tracking-wider">
                Or begin with
              </p>
              <div className="pointer-events-auto mt-2 flex flex-wrap items-center justify-center gap-2">
                {(["Input", "LLM Node", "Output"] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleAddNode(type)}
                    className="flex items-center gap-2 rounded-[2px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] font-semibold text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    <TypeIcon type={type} className="icon-xs text-[var(--accent)]" />
                    {connectionForNode(type).label.split(" · ")[0]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {saveMessage && (
          <div className="absolute right-4 top-4 rounded-[2px] border border-[var(--border-strong)] border-l-[3px] border-l-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-[10px] text-[var(--text)] shadow-[var(--shadow-pop)]">
            {saveMessage}
          </div>
        )}
      </div>
    </BuilderLayout>
  );
}

export default function WorkflowBuilderPage() {
  return (
    <React.Suspense fallback={<div className="h-screen w-screen flex items-center justify-center bg-background text-muted text-sm">Loading the builder…</div>}>
      <WorkflowBuilderInner />
    </React.Suspense>
  );
}
