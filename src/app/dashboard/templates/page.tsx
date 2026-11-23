"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Download, LayoutTemplate, Headphones, Megaphone, Code2, BarChart3, Scale, ListChecks, Server, TrendingUp, Workflow, Plane, GraduationCap } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/Button";

const CATEGORY_ICONS: Record<string, React.FC<{ className?: string }>> = {
  "Customer Service": Headphones,
  "Marketing Automation": Megaphone,
  "Developer Tools": Code2,
  "Business Intelligence": BarChart3,
  "Legal & Compliance": Scale,
  Productivity: ListChecks,
  DevOps: Server,
  Growth: TrendingUp,
  Automation: Workflow,
  Lifestyle: Plane,
  Education: GraduationCap,
};

export default function TemplateMarketplacePage() {
  const router = useRouter();

  const [searchQuery, setSearchQuery] = React.useState("");
  const [category, setCategory] = React.useState<string>("All");
  const [popularOnly, setPopularOnly] = React.useState<boolean>(false);
  const [minRating, setMinRating] = React.useState<number>(4.0);

  const templates = [
    {
      name: "Customer Support Helper",
      category: "Customer Service",
      model: "GPT-4o",
      nodes: 7,
      rating: 4.9,
      downloads: "1.2k",
      desc: "Reads customer messages, looks in your support files for answers, drafts a reply, and passes the hard ones to a person.",
      popular: true,
    },
    {
      name: "New Lead Helper",
      otherApp: true,
      category: "Marketing Automation",
      model: "Claude 3.5 Sonnet",
      nodes: 6,
      rating: 4.8,
      downloads: "940",
      desc: "When someone signs up, looks them up, works out how good a fit they are, and writes a welcome message for them.",
      popular: false,
    },
    {
      name: "Code Checker",
      category: "Developer Tools",
      model: "Llama 3.1 70B",
      nodes: 8,
      rating: 4.7,
      downloads: "630",
      desc: "Reads code changes, spots leaked passwords and style problems, and leaves clear notes on what to fix.",
      popular: true,
    },
    {
      name: "News Mood Reader",
      category: "Business Intelligence",
      model: "DeepSeek V3",
      nodes: 5,
      rating: 4.9,
      downloads: "810",
      desc: "Reads news feeds, works out whether the mood is good or bad, and writes a short weekly summary.",
      popular: false,
    },

    {
      name: "Contract Questions",
      files: true,
      category: "Legal & Compliance",
      model: "GPT-4o",
      nodes: 9,
      rating: 4.8,
      downloads: "510",
      desc: "Uploads contracts, answers questions about what they say, and flags wording that could cause trouble.",
      popular: true,
    },
    {
      name: "Policy Writer",
      category: "Legal & Compliance",
      model: "Llama 3.1 70B",
      nodes: 6,
      rating: 4.6,
      downloads: "420",
      desc: "Turns your rules into clear written policies and makes checklists you can show in an audit.",
      popular: false,
    },
    {
      name: "Translator",
      category: "Productivity",
      model: "GPT-4o",
      nodes: 4,
      rating: 4.7,
      downloads: "980",
      desc: "Spots the language, translates it, and keeps the tone and special words the same.",
      popular: true,
    },
    {
      name: "Meeting Notes to Tasks",
      category: "Productivity",
      model: "Claude 3.5 Sonnet",
      nodes: 5,
      rating: 4.8,
      downloads: "760",
      desc: "Turns meeting notes into a short summary, and makes a list of tasks with who does what and by when.",
      popular: false,
    },

    {
      name: "Help Article Shortener",
      files: true,
      category: "Customer Service",
      model: "DeepSeek V3",
      nodes: 4,
      rating: 4.5,
      downloads: "390",
      desc: "Reads long help articles and writes short, simple versions for your help centre.",
      popular: false,
    },
    {
      name: "Incident Report Writer",
      category: "DevOps",
      model: "GPT-4o",
      nodes: 7,
      rating: 4.9,
      downloads: "680",
      desc: "Reads what happened during an outage and writes a calm report about what went wrong and what to do next — no blame.",
      popular: true,
    },
    {
      name: "Release Checker",
      category: "DevOps",
      model: "Llama 3.1 70B",
      nodes: 6,
      rating: 4.6,
      downloads: "510",
      desc: "Reads the release notes and code changes, guesses what could go wrong, and suggests a safer way to roll it out.",
      popular: false,
    },
    {
      name: "Web Page Checker",
      category: "Growth",
      model: "GPT-4o",
      nodes: 6,
      rating: 4.7,
      downloads: "430",
      desc: "Reads a page and points out confusing words, missing details, and things that stop people buying or signing up.",
      popular: false,
    },

    {
      name: "Customers at Risk",
      category: "Business Intelligence",
      model: "DeepSeek V3",
      nodes: 7,
      rating: 4.7,
      downloads: "740",
      desc: "Looks at how people use your product and their support history, and flags who might leave — with ideas to keep them.",
      popular: true,
    },
    {
      name: "Feedback Sorter",
      category: "Growth",
      model: "Claude 3.5 Sonnet",
      nodes: 5,
      rating: 4.8,
      downloads: "1.0k",
      desc: "Groups similar feedback together, labels it, and writes clear tasks for the team.",
      popular: true,
    },

    {
      name: "New Event Helper",
      otherApp: true,
      category: "Automation",
      model: "GPT-4o",
      nodes: 6,
      rating: 4.6,
      downloads: "520",
      desc: "When another app sends a message, sends it to the right place, adds useful details, and tidies it up for the next step.",
      popular: false,
    },
    {
      name: "Data Checker",
      otherApp: true,
      category: "Automation",
      model: "Llama 3.1 70B",
      nodes: 5,
      rating: 4.5,
      downloads: "310",
      desc: "Checks your data for mistakes and missing pieces, and writes plain steps to fix them.",
      popular: false,
    },

    {
      name: "Travel Itinerary Builder",
      category: "Lifestyle",
      model: "GPT-4o",
      nodes: 6,
      rating: 4.7,
      downloads: "880",
      desc: "Builds a day-by-day trip plan from what you like, your budget, and a backup plan if the weather turns.",
      popular: true,
    },
    {
      name: "CV Improver",
      category: "Lifestyle",
      model: "Claude 3.5 Sonnet",
      nodes: 5,
      rating: 4.8,
      downloads: "1.1k",
      desc: "Reads your CV and a job advert, matches the right words, and rewrites it so hiring software can read it.",
      popular: false,
    },

    {
      name: "Lesson Planner",
      category: "Education",
      model: "DeepSeek V3",
      nodes: 6,
      rating: 4.6,
      downloads: "360",
      desc: "Writes lesson plans, quizzes, and project ideas that match what students need to learn.",
      popular: false,
    },
    {
      name: "Study Session Planner",
      category: "Education",
      model: "GPT-4o",
      nodes: 4,
      rating: 4.7,
      downloads: "640",
      desc: "Builds a study plan that repeats the hard parts, focuses on weak spots, and breaks work into small steps.",
      popular: true,
    },
  ];

  const categories = React.useMemo(() => {
    const set = new Set<string>(templates.map((t) => t.category));
    return ["All", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [templates]);

  const filteredTemplates = templates.filter((temp) => {
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch =
      q.length === 0 ||
      temp.name.toLowerCase().includes(q) ||
      temp.category.toLowerCase().includes(q);

    const matchesCategory = category === "All" || temp.category === category;
    const matchesPopular = !popularOnly || temp.popular;
    const matchesRating = temp.rating >= minRating;

    return matchesSearch && matchesCategory && matchesPopular && matchesRating;
  });

  const deployTemplate = (template: (typeof templates)[number]) => {
    // Explicit flags on the template (not keyword checks on the description):
    // the descriptions are plain words now, so the old "webhook"/"knowledge"
    // keyword test would silently drop steps from the built workflow.
    const usesRag = Boolean((template as { files?: boolean }).files);
    const usesApi = Boolean((template as { otherApp?: boolean }).otherApp);
    const nodeTypes = [
      { type: "trigger" as const, name: "Start", description: "Where the work begins." },
      ...(usesRag ? [{ type: "rag" as const, name: "Search your files", description: "Looks in your files for the right information." }] : []),
      ...(usesApi ? [{ type: "api" as const, name: "Talk to another app", description: "Gets information from another app." }] : []),
      { type: "llm" as const, name: `${template.model} Agent`, description: template.desc },
      { type: "output" as const, name: "Give the answer", description: "Returns the finished result." },
    ];
    const nodes = nodeTypes.slice(0, Math.max(4, Math.min(template.nodes, nodeTypes.length))).map((node, index) => ({
      id: `template-${index + 1}`,
      ...node,
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      id: `template-edge-${index + 1}`,
      source: nodes[index].id,
      target: node.id,
    }));

    const workflow = encodeURIComponent(JSON.stringify({ nodes, edges }));
    router.push(
      `/workflow-builder?agentName=${encodeURIComponent(template.name)}&workflow=${workflow}`,
    );
  };


  return (
    <DashboardLayout>
      <div className="space-y-8 select-none text-left">
        {/* Header Title */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="font-h1 font-bold text-[var(--text)] flex items-center gap-2">
              <LayoutTemplate className="icon-lg text-[var(--accent)]" />
              Ready-made agents
            </h2>
            <p className="text-xs text-muted">
              Pick one to start from. It opens in the builder, ready for you to change.
            </p>
          </div>

          <div className="max-w-xs w-full relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 icon-xs text-muted" />
            <input
              type="text"
              placeholder="Search by name or type..."
              aria-label="Search templates"
              className="input w-full pl-9 pr-3 py-1.5 text-xs"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="min-w-[180px]">
              <label className="block text-[10px] text-muted font-semibold mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="select w-full px-3 py-1.5 text-xs"
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="popularOnly"
                type="checkbox"
                checked={popularOnly}
                onChange={(e) => setPopularOnly(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <label htmlFor="popularOnly" className="text-[10px] text-muted font-semibold">
                Most popular only
              </label>
            </div>

            <div className="min-w-[160px]">
              <label className="block text-[10px] text-muted font-semibold mb-1">
                Lowest rating: {minRating.toFixed(1)}+
              </label>
              <input
                type="range"
                min={0}
                max={5}
                step={0.1}
                value={minRating}
                aria-label="Lowest rating"
                onChange={(e) => setMinRating(parseFloat(e.target.value))}
                className="w-full accent-[var(--accent)]"
              />
            </div>
          </div>

        </div>

        {/* Template registry: ruled rows, not cards */}
        <div className="border-t border-[var(--border)]">
          {filteredTemplates.map((temp) => {
            const CategoryIcon = CATEGORY_ICONS[temp.category] ?? LayoutTemplate;
            return (
            <div key={temp.name} className="ruled-row flex flex-col gap-2 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-start gap-3">
                  <CategoryIcon className="icon-sm shrink-0 mt-0.5 text-[var(--accent)]" aria-hidden />
                  <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold text-[var(--text)]">{temp.name}</span>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">{temp.category}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted leading-relaxed max-w-[68ch]">
                    {temp.desc}
                  </p>
                  </div>
                </div>
                {temp.popular && (
                  <span className="status-line shrink-0">
                    <span className="lamp lamp-ok" />
                    Popular
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  Rated {temp.rating.toFixed(1)} · {temp.nodes} steps · {temp.model}
                </span>
                <Button size="sm" onClick={() => deployTemplate(temp)}>
                  <Download className="icon-xs mr-1.5" />
                  Use this one
                </Button>
              </div>
            </div>
            );
          })}

          {filteredTemplates.length === 0 && (
            <div className="py-12 text-center text-xs text-muted border-b border-[var(--border)]">
              Nothing matched. Try a different word, or clear the filters above.
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
