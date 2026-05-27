import { getDb } from "./db";
import { getEnv } from "./context";
import { aiRuns } from "./schema";
import { prefixedId } from "./ids";

export type AiKind =
  | "summary"
  | "explain"
  | "standup"
  | "refactor"
  | "db"
  | "architecture"
  | "chat"
  | "code-review"
  | "task-breakdown"
  | "blockers";
export type AiPlatform = "gemini" | "claude" | "gpt";

const PLATFORM_LABEL: Record<AiPlatform, string> = {
  gemini: "Gemini 1.5 Pro",
  claude: "Claude 3.5 Sonnet",
  gpt: "GPT-4o",
};

const PLATFORM_MODEL: Record<AiPlatform, string> = {
  gemini: "gpt-4o-mini",
  claude: "gpt-4o-mini",
  gpt: "gpt-4o-mini",
};

export interface AiRequest {
  kind: AiKind;
  platform?: AiPlatform;
  prompt: string;
  context?: string;
}

export interface AiResponse {
  output: string;
  model: string;
  provider: "openai" | "mock";
  data?: AiStructured;
}

export type AiStructured =
  | { kind: "code-review"; score: number; summary: string; issues: AiIssue[] }
  | { kind: "task-breakdown"; subtasks: AiSubtask[] }
  | { kind: "blockers"; blocked: AiBlocker[] };

export interface AiIssue {
  severity: "info" | "warn" | "error";
  category: "bug" | "performance" | "readability" | "security";
  line?: number;
  message: string;
}

export interface AiSubtask {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  labels?: { name: string; tone: "green" | "blue" | "yellow" | "red" | "gray" }[];
  estimate?: string;
}

export interface AiBlocker {
  taskId?: string;
  title: string;
  reason: string;
  daysStuck?: number;
}

function systemPrompt(kind: AiKind, platform: AiPlatform): string {
  const persona = PLATFORM_LABEL[platform];
  switch (kind) {
    case "summary":
      return `You are ${persona} helping summarize a developer wiki page. Respond in concise Markdown with 3-5 bullet points and a one-line conclusion.`;
    case "explain":
      return `You are ${persona}, a senior code reviewer. Explain the provided snippet in plain English. Cover purpose, structure, and one improvement suggestion in bullet points.`;
    case "standup":
      return `You are ${persona}. Draft a brief engineering standup from the given activity. Use bullet points grouped by Yesterday / Today / Blockers.`;
    case "refactor":
      return `You are ${persona}. Suggest a concrete refactor for the provided code. Return a short paragraph plus a fenced TypeScript code block with the improved version.`;
    case "db":
      return `You are ${persona}. Help the developer with Cloudflare D1 / SQLite questions. Provide a short explanation and a runnable example.`;
    case "architecture":
      return `You are ${persona}. Explain the codebase architecture and how SSR + client routing collaborate. Use 3-4 numbered points.`;
    case "code-review":
      return `You are ${persona}, a meticulous senior code reviewer. Review the provided code for bugs, performance issues, readability suggestions, and security concerns. Respond ONLY with strict JSON of shape: {"score":1-10, "summary":"...", "issues":[{"severity":"info|warn|error","category":"bug|performance|readability|security","line":<int|null>,"message":"..."}]}. No prose outside the JSON.`;
    case "task-breakdown":
      return `You are ${persona}. Break the user's feature description into 4-8 concrete engineering subtasks. Respond ONLY with strict JSON of shape: {"subtasks":[{"title":"...","description":"...","priority":"low|medium|high|urgent","labels":[{"name":"...","tone":"green|blue|yellow|red|gray"}],"estimate":"e.g. 2h | 1d"}]}. No prose outside the JSON.`;
    case "blockers":
      return `You are ${persona}. Identify blocked tasks from the provided task list. A task is blocked if it has been in "in_progress" or "review" for more than 5 days, or if its description mentions waiting/blocked. Respond ONLY with strict JSON of shape: {"blocked":[{"taskId":"...","title":"...","reason":"...","daysStuck":<int>}]}. No prose outside the JSON.`;
    default:
      return `You are ${persona}, a developer-focused assistant inside DevCollab.`;
  }
}

function tryParseStructured(kind: AiKind, raw: string): AiStructured | undefined {
  // Strip code fences if the model wrapped JSON in them.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (kind === "code-review") {
      const score = Number(parsed.score ?? 5);
      const summary = String(parsed.summary ?? "");
      const issues = Array.isArray(parsed.issues)
        ? (parsed.issues as Record<string, unknown>[]).slice(0, 30).map((i) => ({
            severity:
              (["info", "warn", "error"].includes(String(i.severity)) ? i.severity : "info") as AiIssue["severity"],
            category:
              (["bug", "performance", "readability", "security"].includes(String(i.category))
                ? i.category
                : "readability") as AiIssue["category"],
            line: Number.isFinite(Number(i.line)) ? Number(i.line) : undefined,
            message: String(i.message ?? ""),
          }))
        : [];
      return { kind: "code-review", score: Math.max(1, Math.min(10, Math.round(score))), summary, issues };
    }
    if (kind === "task-breakdown") {
      const subtasks = Array.isArray(parsed.subtasks)
        ? (parsed.subtasks as Record<string, unknown>[]).slice(0, 12).map((s) => ({
            title: String(s.title ?? ""),
            description: String(s.description ?? ""),
            priority: (["low", "medium", "high", "urgent"].includes(String(s.priority))
              ? s.priority
              : "medium") as AiSubtask["priority"],
            labels: Array.isArray(s.labels)
              ? (s.labels as Record<string, unknown>[]).slice(0, 5).map((l) => ({
                  name: String(l.name ?? ""),
                  tone: (["green", "blue", "yellow", "red", "gray"].includes(String(l.tone))
                    ? l.tone
                    : "gray") as "green" | "blue" | "yellow" | "red" | "gray",
                }))
              : undefined,
            estimate: s.estimate ? String(s.estimate) : undefined,
          }))
        : [];
      return { kind: "task-breakdown", subtasks };
    }
    if (kind === "blockers") {
      const blocked = Array.isArray(parsed.blocked)
        ? (parsed.blocked as Record<string, unknown>[]).slice(0, 20).map((b) => ({
            taskId: b.taskId ? String(b.taskId) : undefined,
            title: String(b.title ?? ""),
            reason: String(b.reason ?? ""),
            daysStuck: Number.isFinite(Number(b.daysStuck)) ? Number(b.daysStuck) : undefined,
          }))
        : [];
      return { kind: "blockers", blocked };
    }
  } catch {
    // fall through
  }
  return undefined;
}

async function callOpenAi(req: AiRequest, platform: AiPlatform): Promise<AiResponse | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) return null;
  const model = env.OPENAI_MODEL ?? PLATFORM_MODEL[platform];
  const base = env.AI_BASE_URL ?? "https://api.openai.com/v1";

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt(req.kind, platform) },
      ...(req.context ? [{ role: "user" as const, content: `Context:\n${req.context}` }] : []),
      { role: "user" as const, content: req.prompt },
    ],
    temperature: 0.4,
    max_tokens: 600,
  };

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("OpenAI call failed", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const output = data.choices?.[0]?.message?.content?.trim();
    if (!output) return null;
    return { output, model, provider: "openai" };
  } catch (err) {
    console.error("OpenAI fetch error", err);
    return null;
  }
}

function deterministicOutput(req: AiRequest, platform: AiPlatform): string {
  const persona = PLATFORM_LABEL[platform];
  switch (req.kind) {
    case "summary": {
      const headings = (req.context ?? req.prompt)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("#") || l.startsWith("-") || l.startsWith("*"))
        .slice(0, 5)
        .map((l) => l.replace(/^#+\s*|^[-*]\s*/g, ""));
      const bullets = (
        headings.length
          ? headings
          : [
              "Overview of purpose and scope.",
              "Setup steps and prerequisites.",
              "Key APIs and conventions.",
              "Common pitfalls to watch for.",
            ]
      ).map((h) => `- ${h}`);
      return `### AI Summary (${persona})\n\n${bullets.join("\n")}\n\n_Generated locally without an LLM key._`;
    }
    case "explain": {
      const src = req.context ?? req.prompt;
      const lines = src.split("\n").length;
      const imports = src
        .split("\n")
        .filter((l) => l.trim().startsWith("import"))
        .map((l) => l.replace(/[`"';]/g, "").trim())
        .slice(0, 3);
      return [
        `### Code Walkthrough (${persona})`,
        ``,
        `- **Shape**: ${lines}-line module.`,
        imports.length
          ? `- **External APIs**: ${imports.join(", ")}.`
          : `- **Pure**: no external imports.`,
        `- **Behavior**: Encapsulates a reusable workspace helper with minimal side-effects.`,
        `- **Suggestion**: Extract magic numbers into named constants and add a guard for the null path.`,
        ``,
        `_Generated locally without an LLM key._`,
      ].join("\n");
    }
    case "standup": {
      return [
        `### Standup draft — ${persona}`,
        ``,
        `**Yesterday**`,
        `- Closed two PRs on board drag-and-drop and wiki autosave.`,
        ``,
        `**Today**`,
        `- Finish SSO smoke tests and prep release notes for v1.4.`,
        ``,
        `**Blockers**`,
        `- Waiting on Okta sandbox keys.`,
        ``,
        `_Generated locally without an LLM key._`,
      ].join("\n");
    }
    case "refactor": {
      return [
        `### Refactor proposal (${persona})`,
        ``,
        `Extract the state mutation into a pure reducer that is easier to unit test.`,
        ``,
        "```typescript",
        `export function moveTask(tasks: Task[], id: string, nextStatus: Status): Task[] {`,
        `  return tasks.map((t) => (t.id === id ? { ...t, status: nextStatus } : t));`,
        `}`,
        "```",
        ``,
        `_Generated locally without an LLM key._`,
      ].join("\n");
    }
    case "db": {
      return [
        `### Cloudflare D1 quick guide (${persona})`,
        ``,
        `D1 is a serverless SQLite database accessible via the \`DB\` binding.`,
        ``,
        "```sql",
        `CREATE TABLE wiki_pages (`,
        `  id TEXT PRIMARY KEY,`,
        `  title TEXT NOT NULL,`,
        `  content TEXT,`,
        `  category TEXT DEFAULT 'General'`,
        `);`,
        "```",
        ``,
        "Apply with: `bun run db:migrate:local`.",
        ``,
        `_Generated locally without an LLM key._`,
      ].join("\n");
    }
    case "architecture": {
      return [
        `### DevCollab architecture (${persona})`,
        ``,
        `1. **Edge SSR** via TanStack Start on Cloudflare Workers.`,
        `2. **D1** holds users, workspaces, projects, tasks, wiki, and snippets.`,
        `3. **Hono** mounted at \`/api/*\` handles all mutations with cookie sessions.`,
        `4. **React Query** caches data on the client and invalidates after mutations.`,
        ``,
        `_Generated locally without an LLM key._`,
      ].join("\n");
    }
    case "code-review": {
      const src = req.context ?? req.prompt;
      const lines = src.split("\n");
      const hasAny = (re: RegExp) => lines.some((l) => re.test(l));
      const issues: AiIssue[] = [];
      if (hasAny(/==/) && !hasAny(/===/))
        issues.push({
          severity: "warn",
          category: "bug",
          message: "Prefer strict equality (===) to avoid coercion bugs.",
        });
      if (hasAny(/console\.log/))
        issues.push({
          severity: "info",
          category: "readability",
          message: "Strip console.log calls before shipping or replace with a logger.",
        });
      if (hasAny(/eval\(/))
        issues.push({
          severity: "error",
          category: "security",
          message: "eval() is unsafe — avoid executing dynamic strings.",
        });
      if (hasAny(/innerHTML\s*=/))
        issues.push({
          severity: "error",
          category: "security",
          message: "Assigning to innerHTML can introduce XSS; sanitize or use textContent.",
        });
      if (hasAny(/for\s*\(.*\.length/))
        issues.push({
          severity: "info",
          category: "performance",
          message: "Cache array.length in the loop variable to avoid repeated lookups.",
        });
      if (hasAny(/any/))
        issues.push({
          severity: "info",
          category: "readability",
          message: "`any` weakens type safety — narrow to a precise type.",
        });
      if (!issues.length)
        issues.push({
          severity: "info",
          category: "readability",
          message: "No obvious issues found in the static heuristic pass.",
        });
      const score = Math.max(4, 10 - issues.filter((i) => i.severity !== "info").length * 2);
      return JSON.stringify({
        score,
        summary: `Static heuristic review by ${persona}: ${lines.length} lines analyzed, ${issues.length} findings.`,
        issues,
      });
    }
    case "task-breakdown": {
      const feature = req.prompt.trim().slice(0, 80);
      const subtasks: AiSubtask[] = [
        {
          title: `Design data model for ${feature}`,
          description: "Sketch the tables/columns and write a migration.",
          priority: "high",
          labels: [{ name: "backend", tone: "blue" }],
          estimate: "3h",
        },
        {
          title: `Backend endpoints for ${feature}`,
          description: "Implement CRUD routes with Zod validation and tests.",
          priority: "high",
          labels: [{ name: "backend", tone: "blue" }],
          estimate: "4h",
        },
        {
          title: `Frontend UI for ${feature}`,
          description: "Build the page and wire it to the API client with optimistic updates.",
          priority: "medium",
          labels: [{ name: "frontend", tone: "green" }],
          estimate: "5h",
        },
        {
          title: `Error & loading states`,
          description: "Add skeletons, empty states, and friendly error messages.",
          priority: "medium",
          labels: [{ name: "ux", tone: "yellow" }],
          estimate: "1h",
        },
        {
          title: `Tests & QA pass`,
          description: "Add unit and integration tests; manual smoke test on staging.",
          priority: "medium",
          labels: [{ name: "qa", tone: "gray" }],
          estimate: "2h",
        },
        {
          title: `Docs + release notes`,
          description: "Update the wiki page and add a changelog entry.",
          priority: "low",
          labels: [{ name: "docs", tone: "gray" }],
          estimate: "30m",
        },
      ];
      return JSON.stringify({ subtasks });
    }
    case "blockers": {
      return JSON.stringify({
        blocked: [
          {
            title: "Refresh-token rotation",
            reason: "Awaiting Okta sandbox keys for 6 days.",
            daysStuck: 6,
          },
          {
            title: "Onboarding email copy",
            reason: "Waiting on marketing sign-off.",
            daysStuck: 4,
          },
        ],
      });
    }
    default:
      return `${persona}: ${req.prompt}`;
  }
}

export async function runAi(req: AiRequest, userId: string): Promise<AiResponse> {
  const platform = req.platform ?? "gemini";
  const real = await callOpenAi(req, platform);
  const baseResponse: AiResponse = real ?? {
    output: deterministicOutput(req, platform),
    model: `${platform}-mock`,
    provider: "mock" as const,
  };
  const structured =
    req.kind === "code-review" || req.kind === "task-breakdown" || req.kind === "blockers"
      ? tryParseStructured(req.kind, baseResponse.output)
      : undefined;
  const response: AiResponse = structured ? { ...baseResponse, data: structured } : baseResponse;
  try {
    await getDb()
      .insert(aiRuns)
      .values({
        id: prefixedId("air"),
        userId,
        kind: req.kind,
        input: req.prompt.slice(0, 4000),
        output: response.output.slice(0, 8000),
        model: response.model,
      });
  } catch (err) {
    console.error("Failed to persist AI run", err);
  }
  return response;
}
