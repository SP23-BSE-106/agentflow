/**
 * App marks for the workflow builder canvas.
 *
 * One small inline-SVG mark per app or service a step can involve, the way
 * n8n shows an integration icon on each node — so a layman can tell at a
 * glance what a step connects to. Every mark is drawn here by hand as
 * simple geometry (stroke `currentColor`, one stroke width, 24x24 grid);
 * nothing is hotlinked, downloaded, or traced from another product's logo.
 * Where a service has no safe simplified mark, the mark is a plain
 * geometric reading of what the service *does* (a route, a chip, a face,
 * a moon) rather than its trademark — and the plain-English label next to
 * it carries the meaning, not the drawing alone.
 *
 * Display only: these marks never affect what a step runs.
 */

import type { ComponentType } from "react";

export type AppMarkProps = {
  className?: string;
};

type Mark = ComponentType<AppMarkProps>;

function baseProps(className?: string) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

/** OpenRouter — one message in, three routes out. */
const OpenRouterMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <circle cx="4.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M6.5 12 H10 M10 12 L18.5 5.5 M10 12 H18.5 M10 12 L18.5 18.5" />
    <circle cx="20.5" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="20.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="20.5" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

/** NVIDIA — a chip: the graphics card the model runs on. */
const NvidiaMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <rect x="10.5" y="10.5" width="3" height="3" rx="0.5" fill="currentColor" stroke="none" />
    <path d="M10 7 V4.5 M14 7 V4.5 M10 19.5 V17 M14 19.5 V17 M7 10 H4.5 M7 14 H4.5 M19.5 10 H17 M19.5 14 H17" />
  </svg>
);

/** Hugging Face — a plain smiling face. */
const HuggingFaceMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="9" cy="10" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r="0.9" fill="currentColor" stroke="none" />
    <path d="M8.5 14.5 Q12 17.5 15.5 14.5" />
  </svg>
);

/** Moonshot — a crescent moon and a small star. */
const MoonshotMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M19.5 14.5 A8.5 8.5 0 1 1 9.5 4.5 A6.8 6.8 0 0 0 19.5 14.5 Z" />
    <path d="M18.5 2.5 l.8 1.9 1.9.8 -1.9.8 -.8 1.9 -.8-1.9 -1.9-.8 1.9-.8 Z" fill="currentColor" stroke="none" />
  </svg>
);

/** Generic AI step — a spark, used when no provider is picked yet. */
const AiMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M12 3.5 L13.6 10.4 L20.5 12 L13.6 13.6 L12 20.5 L10.4 13.6 L3.5 12 L10.4 10.4 Z" />
    <path d="M18.5 15.5 l.6 1.5 1.5.6 -1.5.6 -.6 1.5 -.6-1.5 -1.5-.6 1.5-.6 Z" fill="currentColor" stroke="none" />
  </svg>
);

/** Your files — a folder. */
const FilesMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M3.5 7.5 A2 2 0 0 1 5.5 5.5 H9 l2 2.5 H18.5 A2 2 0 0 1 20.5 10 V17.5 A2 2 0 0 1 18.5 19.5 H5.5 A2 2 0 0 1 3.5 17.5 Z" />
  </svg>
);

/** Web call — a globe. */
const WebMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12 H20.5 M12 3.5 C15 7 15 17 12 20.5 C9 17 9 7 12 3.5 Z" />
  </svg>
);

/** Link start / webhook — a chain link. */
const LinkMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M10 14.5 A4 4 0 0 0 15.5 14.5 L18.5 11.5 A4 4 0 0 0 12.8 5.8 L11.3 7.3" />
    <path d="M14 9.5 A4 4 0 0 0 8.5 9.5 L5.5 12.5 A4 4 0 0 0 11.2 18.2 L12.7 16.7" />
  </svg>
);

/** Timed start / schedule — a clock. */
const ClockMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7 V12 L15.5 14" />
  </svg>
);

/** Form start — a form sheet with a tick. */
const FormMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M9 4.5 H15 M10.5 4.5 A1.5 1.5 0 0 1 13.5 4.5" />
    <path d="M6 6.5 H18 V19.5 A1.5 1.5 0 0 1 16.5 21 H7.5 A1.5 1.5 0 0 1 6 19.5 Z" />
    <path d="M9 13.5 L11 15.5 L15 11" />
  </svg>
);

/** Error start — a warning triangle. */
const ErrorMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M12 4 L21 19.5 H3 Z" />
    <path d="M12 10 V14.5" />
    <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

/** Run another flow — a small flow with a play triangle. */
const RunFlowMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <rect x="3" y="4" width="10" height="7" rx="1.5" />
    <rect x="11" y="13" width="10" height="7" rx="1.5" />
    <path d="M9.5 17.5 L9.5 14.5 L12 16 Z" fill="currentColor" stroke="none" />
    <path d="M8 11 V13 M13 11 V13" />
  </svg>
);

/** Answer — a speech bubble with a reply arrow. */
const AnswerMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M4 5.5 H20 V15.5 H12 L7 20 V15.5 H4 Z" />
    <path d="M8.5 10.5 H15.5 M13 8 L15.5 10.5 L13 13" />
  </svg>
);

/** Choice — one way in, two ways out. */
const ChoiceMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <circle cx="6" cy="5" r="1.8" />
    <circle cx="18" cy="5" r="1.8" />
    <circle cx="12" cy="19" r="1.8" />
    <path d="M6 6.8 L12 17.2 M18 6.8 L12 17.2" />
  </svg>
);

/** Start — a play button. */
const StartMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10 8.5 L16 12 L10 15.5 Z" fill="currentColor" stroke="none" />
  </svg>
);

/** Run code — angle brackets. */
const CodeMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M8.5 7.5 L4 12 L8.5 16.5 M15.5 7.5 L20 12 L15.5 16.5" />
  </svg>
);

/** Set values — three sliders. */
const SetMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M4 7 H20 M4 12 H20 M4 17 H20" />
    <circle cx="9" cy="7" r="1.8" fill="var(--surface)" />
    <circle cx="15" cy="12" r="1.8" fill="var(--surface)" />
    <circle cx="7" cy="17" r="1.8" fill="var(--surface)" />
  </svg>
);

/** Join flows — two arrows into one. */
const MergeMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M5 5 L11 12 L5 19 M19 5 L13 12 L19 19" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

/** In small groups — stacked layers. */
const BatchesMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M12 3.5 L20.5 8 L12 12.5 L3.5 8 Z" />
    <path d="M3.5 12.5 L12 17 L20.5 12.5" />
    <path d="M3.5 16.5 L12 21 L20.5 16.5" />
  </svg>
);

/** Pause — an hourglass. */
const WaitMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M6.5 4 H17.5 M6.5 20 H17.5 M7.5 4 C7.5 10 16.5 10 16.5 20 M16.5 4 C16.5 10 7.5 10 7.5 20" />
  </svg>
);

/** Button start — a pressable button. */
const PressMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </svg>
);

/** Reply to the link — an arrow curving back. */
const RespondMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <path d="M9 13.5 L4.5 9 L9 4.5" />
    <path d="M4.5 9 H14 A5.5 5.5 0 0 1 19.5 14.5 V19" />
  </svg>
);

/** Called by another flow — an arrow into a frame. */
const CallFlowMark: Mark = ({ className }) => (
  <svg {...baseProps(className)}>
    <rect x="12.5" y="4.5" width="8" height="15" rx="1.5" />
    <path d="M10.5 12 H3 M7 8.5 L3.5 12 L7 15.5" />
  </svg>
);

export const APP_MARKS = {
  openrouter: OpenRouterMark,
  nvidia: NvidiaMark,
  huggingface: HuggingFaceMark,
  moonshot: MoonshotMark,
  ai: AiMark,
  files: FilesMark,
  web: WebMark,
  link: LinkMark,
  clock: ClockMark,
  form: FormMark,
  error: ErrorMark,
  "run-flow": RunFlowMark,
  answer: AnswerMark,
  choice: ChoiceMark,
  start: StartMark,
  code: CodeMark,
  set: SetMark,
  merge: MergeMark,
  batches: BatchesMark,
  wait: WaitMark,
  press: PressMark,
  respond: RespondMark,
  "call-flow": CallFlowMark,
} as const;

export type AppMarkKey = keyof typeof APP_MARKS;

/** Render the mark for a key. Unknown keys fall back to the generic AI spark. */
export function AppMark({ markKey, className }: { markKey?: string; className?: string }) {
  const Mark = (markKey ? (APP_MARKS as Record<string, Mark>)[markKey] : undefined) ?? AiMark;
  return <Mark className={className} />;
}

/**
 * Which AI provider a configured model runs through. The model ids are the
 * ones the builder's own model picker offers (see the step settings panel):
 * `openai/gpt-4o` is served by OpenRouter, the lowercase `moonshotai/kimi-k3.1-pro`
 * by NVIDIA (the old `moonshotai/kimi-k3` id is kept for saved nodes — it
 * reached end of life on 2026-10-15), the capital-K `moonshotai/Kimi-K3` by
 * Hugging Face, and `moonshot-v1-8k` by Moonshot directly. Anything else —
 * including no model picked yet — has no provider to show.
 */
export function providerForModel(model: unknown): { key: AppMarkKey; label: string } | null {
  if (typeof model !== "string" || !model.trim()) return null;
  switch (model.trim()) {
    case "openai/gpt-4o":
      return { key: "openrouter", label: "OpenRouter" };
    case "moonshotai/kimi-k3.1-pro":
    case "moonshotai/kimi-k3":
      return { key: "nvidia", label: "NVIDIA" };
    case "moonshotai/Kimi-K3":
      return { key: "huggingface", label: "Hugging Face" };
    case "moonshot-v1-8k":
      return { key: "moonshot", label: "Moonshot" };
    default:
      return null;
  }
}

export type NodeConnection = {
  /** Mark key to show on the card, in the library, and in the settings panel. */
  key: AppMarkKey;
  /** Plain-English line: what the step is, and what it connects to. */
  label: string;
};

/**
 * The mark and the plain-English connection line for a canvas node kind.
 * `type` is the canvas display name (`data.type`); `config` is the node's
 * saved config, used only to pick the AI provider for an AI step. Display
 * only — the stored type and config are untouched.
 */
export function connectionForNode(
  type?: string,
  config?: Record<string, unknown> | null,
): NodeConnection {
  switch (type) {
    case "Input":
      return { key: "start", label: "Start · a message arrives" };
    case "LLM Node": {
      const provider = providerForModel(config?.model);
      return provider
        ? { key: provider.key, label: `AI step · ${provider.label}` }
        : { key: "ai", label: "AI step · your AI provider" };
    }
    case "RAG Node":
      return { key: "files", label: "Your files · files you uploaded" };
    case "API Node":
      return { key: "web", label: "Web call · any web address" };
    case "Condition":
      return { key: "choice", label: "Choice · yes or no" };
    case "Output":
      return { key: "answer", label: "Answer · the final result" };
    case "Webhook":
      return { key: "link", label: "Link start · another app" };
    case "Schedule Trigger":
      return { key: "clock", label: "Timed start · on a schedule" };
    case "Manual Trigger":
      return { key: "press", label: "Button start · press Run" };
    case "Form Trigger":
      return { key: "form", label: "Form start · someone fills a form" };
    case "Error Trigger":
      return { key: "error", label: "Error start · when a flow fails" };
    case "Execute Workflow Trigger":
      return { key: "call-flow", label: "Called by another flow" };
    case "Code":
      return { key: "code", label: "Run code · a custom step" };
    case "Set":
      return { key: "set", label: "Set values · change fields" };
    case "HTTP Request":
      return { key: "web", label: "Web call · any web address" };
    case "If":
      return { key: "choice", label: "Choice · yes or no" };
    case "Switch":
      return { key: "choice", label: "Choice · pick a way out" };
    case "Merge":
      return { key: "merge", label: "Join flows · two into one" };
    case "Split In Batches":
      return { key: "batches", label: "In small groups · a few at a time" };
    case "Wait":
      return { key: "wait", label: "Pause · picks up later" };
    case "Respond To Webhook":
      return { key: "respond", label: "Reply to the link · send an answer back" };
    case "Execute Workflow":
      return { key: "run-flow", label: "Run another flow" };
    default:
      return { key: "ai", label: "AI step" };
  }
}
