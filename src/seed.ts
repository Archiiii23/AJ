import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { hashPassword, pickColor } from "./auth";
import { nanoid, prefixedId, slugify } from "./ids";
import {
  activity,
  projects,
  snippets,
  taskLabels,
  tasks,
  users,
  wikiPages,
  workspaceMembers,
  workspaces,
} from "./schema";

const DEMO_EMAIL = "demo@devcollab.app";
const DEMO_PASSWORD = "devcollab123";

const DEMO_USERS = [
  { email: "mira@acme.dev", name: "Mira Chen", role: "owner" as const },
  { email: "ari@acme.dev", name: "Ari Patel", role: "admin" as const },
  { email: "jules@acme.dev", name: "Jules Park", role: "member" as const },
  { email: "noa@acme.dev", name: "Noa Schultz", role: "member" as const },
  { email: "sam@acme.dev", name: "Sam Olu", role: "member" as const },
];

const DEMO_PROJECTS = [
  {
    name: "Platform",
    slug: "platform",
    description: "Core API and infrastructure",
    color: "oklch(0.58 0.15 155)",
  },
  {
    name: "Web App",
    slug: "web",
    description: "Next-gen client experience",
    color: "oklch(0.62 0.14 240)",
  },
  {
    name: "Mobile",
    slug: "mobile",
    description: "iOS + Android shells",
    color: "oklch(0.78 0.14 80)",
  },
  {
    name: "Growth",
    slug: "growth",
    description: "Landing, lifecycle, docs",
    color: "oklch(0.6 0.18 27)",
  },
];

const TASK_TITLES = [
  "Add SSO via Google Workspace",
  "Refactor task drag-drop reducer",
  "Fix race condition in presence channel",
  "Spec the AI standup digest payload",
  "Implement keyboard shortcuts for board",
  "Wire snippets search to OpenSearch",
  "Migrate wiki editor to Tiptap v2",
  "Add audit log export endpoint",
  "Reduce TTFB on /app/projects",
  "Design empty state for AI Hub",
  "Release notes for v1.4",
  "Triage inbound bug reports",
];

const STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
const LABEL_POOL = [
  { name: "frontend", tone: "green" as const },
  { name: "backend", tone: "blue" as const },
  { name: "infra", tone: "gray" as const },
  { name: "bug", tone: "red" as const },
  { name: "design", tone: "yellow" as const },
];

const WIKI_PAGES = [
  {
    title: "Getting Started Guide",
    category: "General",
    content: `# Getting Started Guide\n\nWelcome to the Acme Engineering codebase! This document outlines everything you need to know to get up and running locally.\n\n## Tech Stack\nOur application uses a modern, high-performance tech stack built for velocity:\n- **Core Framework**: React 19 + TanStack Start (SSR)\n- **Routing**: TanStack Router (Fully type-safe)\n- **Styling**: Tailwind CSS v4\n- **Database**: Cloudflare D1 SQLite Database\n\n## Local Installation\nEnsure you have Bun or Node v20+ installed. Then run the following:\n\n\`\`\`bash\nbun install\nbun run dev\n\`\`\`\n\nOpen [http://localhost:8080](http://localhost:8080) to inspect the workspace.\n\n## Coding Guidelines\n- Always ensure components are highly performant and use semantic HTML.\n- Keep styling fully responsive. Prefer mobile-first classes.`,
  },
  {
    title: "API Reference Docs",
    category: "Developer",
    content: `# API Reference Docs\n\nThis reference contains endpoint descriptions, payloads, and request guidelines for our internal gateway.\n\n## Authentication\nAll gateway requests must carry a Bearer JWT Token in the Authorization header:\n\n\`\`\`http\nAuthorization: Bearer <your_jwt_token>\n\`\`\`\n\n## Active Endpoints\n\n### 1. GET /api/v1/projects\nLists all active projects in the current workspace.\n\n**Response Code**: \`200 OK\`\n\n### 2. POST /api/v1/tasks/create\nCreates a new task within a specified project.`,
  },
  {
    title: "Architecture & Dataflow",
    category: "System Design",
    content: `# Architecture & Dataflow\n\nDevCollab relies on a decentralized, distributed event-driven framework to handle collaborative code workspace sessions.\n\n## SSR vs SPA\nWe use **TanStack Start** to server-side render our shell and public landing pages.\n\n## State Management\n- **Server State**: Managed via \`@tanstack/react-query\`.\n- **Local Component State**: Standard React hooks.`,
  },
  {
    title: "Database Schema & Migrations",
    category: "System Design",
    content: `# Database Schema & Migrations\n\nOur database resides in **Cloudflare D1**, a globally distributed serverless SQL database powered by SQLite.\n\n## Core Tables\n\n### Users Table\n\`\`\`sql\nCREATE TABLE users (\n  id TEXT PRIMARY KEY,\n  email TEXT UNIQUE NOT NULL,\n  name TEXT,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);\n\`\`\`\n\n## Running Migrations\nTo apply schema changes locally, run:\n\`\`\`bash\nnpx wrangler d1 migrations apply dev-db --local\n\`\`\``,
  },
];

const SNIPPETS = [
  {
    title: "SSO Config Scaffold",
    description: "Sets up OAuth2 authentication handlers with Google or Okta.",
    language: "typescript",
    code: `import { OAuth2Client } from "google-auth-library";\n\nconst client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);\n\nexport async function verifyToken(idToken: string) {\n  const ticket = await client.verifyIdToken({\n    idToken,\n    audience: process.env.GOOGLE_CLIENT_ID,\n  });\n  const payload = ticket.getPayload();\n  return {\n    email: payload?.email,\n    name: payload?.name,\n    picture: payload?.picture,\n  };\n}`,
  },
  {
    title: "useMobile Hook",
    description: "Tailwind responsive drawer detector React hook.",
    language: "typescript",
    code: `import * as React from "react";\n\nconst MOBILE_BREAKPOINT = 768;\n\nexport function useMobile() {\n  const [isMobile, setIsMobile] = React.useState<boolean>(false);\n\n  React.useEffect(() => {\n    const mql = window.matchMedia(\`(max-width: \${MOBILE_BREAKPOINT - 1}px)\`);\n    const onChange = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);\n    mql.addEventListener("change", onChange);\n    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);\n    return () => mql.removeEventListener("change", onChange);\n  }, []);\n\n  return isMobile;\n}`,
  },
  {
    title: "Vite Configuration (TanStack Start)",
    description: "Fully responsive build setup for Vite including aliases.",
    language: "typescript",
    code: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nimport { tanstackRouter } from "@tanstack/router-plugin/vite";\nimport tsconfigPaths from "vite-tsconfig-paths";\n\nexport default defineConfig({\n  plugins: [\n    tanstackRouter(),\n    react(),\n    tsconfigPaths(),\n  ],\n  server: { port: 8080, strictPort: true },\n});`,
  },
  {
    title: "D1 Database Select Query Helper",
    description: "Drizzle-style select query mapping for D1 bindings.",
    language: "typescript",
    code: `import { drizzle } from "drizzle-orm/d1";\nimport { eq } from "drizzle-orm";\nimport * as schema from "./schema";\n\nexport function getDb(env: { DB: D1Database }) {\n  return drizzle(env.DB, { schema });\n}\n\nexport async function fetchActiveTasks(env: { DB: D1Database }) {\n  const db = getDb(env);\n  return await db\n    .select()\n    .from(schema.tasks)\n    .where(eq(schema.tasks.status, "in_progress"))\n    .execute();\n}`,
  },
];

const dueLabel = (i: number): string | null => (i % 3 === 0 ? `Jun ${10 + (i % 15)}` : null);

export interface SeedResult {
  seeded: boolean;
  reason?: string;
  demoEmail?: string;
  demoPassword?: string;
}

// D1 caps each SQL statement at 100 bound parameters. Drizzle may add columns we omit
// (e.g. notNull fields with defaults), so we chunk conservatively to stay well under
// the limit regardless of how the bind layout shakes out.
const ROWS_PER_BATCH = 4;

async function chunkedInsert<T extends Record<string, unknown>>(
  insertFn: (rows: T[]) => Promise<unknown>,
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
    await insertFn(rows.slice(i, i + ROWS_PER_BATCH));
  }
}

export async function seedIfEmpty(): Promise<SeedResult> {
  const db = getDb();
  const existing = await db.select().from(workspaces).limit(1);
  if (existing.length) return { seeded: false, reason: "already-seeded" };

  const sharedHash = await hashPassword(DEMO_PASSWORD);

  const userRows = DEMO_USERS.map((u) => ({
    id: prefixedId("usr"),
    email: u.email,
    name: u.name,
    passwordHash: sharedHash,
    avatarColor: pickColor(u.email),
  }));
  await chunkedInsert((batch) => db.insert(users).values(batch), userRows);

  const owner = userRows[0];
  const workspaceId = prefixedId("ws");
  await db.insert(workspaces).values({
    id: workspaceId,
    name: "Acme Engineering",
    slug: "acme-engineering",
    ownerId: owner.id,
  });

  await chunkedInsert(
    (batch) => db.insert(workspaceMembers).values(batch),
    userRows.map((u, i) => ({
      workspaceId,
      userId: u.id,
      role: DEMO_USERS[i].role,
    })),
  );

  const projectRows = DEMO_PROJECTS.map((p) => ({
    id: prefixedId("prj"),
    workspaceId,
    name: p.name,
    slug: p.slug,
    description: p.description,
    color: p.color,
  }));
  await chunkedInsert((batch) => db.insert(projects).values(batch), projectRows);

  const platform = projectRows[0];

  const taskInserts: (typeof tasks.$inferInsert)[] = [];
  const labelInserts: (typeof taskLabels.$inferInsert)[] = [];
  TASK_TITLES.forEach((title, i) => {
    const taskId = prefixedId("tsk");
    taskInserts.push({
      id: taskId,
      projectId: platform.id,
      title,
      status: STATUSES[i % STATUSES.length],
      priority: PRIORITIES[i % PRIORITIES.length],
      assigneeId: userRows[i % userRows.length].id,
      due: dueLabel(i),
      position: i * 10,
      createdById: owner.id,
    });
    const labelA = LABEL_POOL[i % LABEL_POOL.length];
    const labelB = LABEL_POOL[(i + 2) % LABEL_POOL.length];
    labelInserts.push({ id: prefixedId("lbl"), taskId, name: labelA.name, tone: labelA.tone });
    labelInserts.push({ id: prefixedId("lbl"), taskId, name: labelB.name, tone: labelB.tone });
  });
  await chunkedInsert((batch) => db.insert(tasks).values(batch), taskInserts);
  await chunkedInsert((batch) => db.insert(taskLabels).values(batch), labelInserts);

  await chunkedInsert(
    (batch) => db.insert(wikiPages).values(batch),
    WIKI_PAGES.map((p, i) => ({
      id: prefixedId("wik"),
      projectId: platform.id,
      title: p.title,
      slug: slugify(p.title),
      category: p.category,
      content: p.content,
      authorId: userRows[i % userRows.length].id,
    })),
  );

  await chunkedInsert(
    (batch) => db.insert(snippets).values(batch),
    SNIPPETS.map((s, i) => ({
      id: prefixedId("snp"),
      projectId: platform.id,
      title: s.title,
      description: s.description,
      language: s.language,
      code: s.code,
      authorId: userRows[i % userRows.length].id,
    })),
  );

  const activityRows = [
    {
      actor: 0,
      action: "moved",
      target: TASK_TITLES[0],
      meta: JSON.stringify({ to: "In review" }),
    },
    { actor: 1, action: "commented on", target: TASK_TITLES[1], meta: null },
    { actor: 2, action: "created task", target: "Audit log export endpoint", meta: null },
    { actor: 3, action: "merged PR for", target: "Snippets search", meta: null },
    { actor: 4, action: "updated wiki", target: "Onboarding runbook", meta: null },
    { actor: 0, action: "closed", target: "Fix race condition in presence", meta: null },
  ];
  await chunkedInsert(
    (batch) => db.insert(activity).values(batch),
    activityRows.map((a) => ({
      id: prefixedId("act"),
      workspaceId,
      projectId: platform.id,
      actorId: userRows[a.actor].id,
      action: a.action,
      targetType: "task",
      targetId: nanoid(8),
      targetLabel: a.target,
      meta: a.meta,
    })),
  );

  return { seeded: true, demoEmail: DEMO_EMAIL, demoPassword: DEMO_PASSWORD };
}

export async function ensureDemoUser(): Promise<{ email: string; password: string }> {
  const db = getDb();
  const existing = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing.length) return { email: DEMO_EMAIL, password: DEMO_PASSWORD };

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const userId = prefixedId("usr");
  await db.insert(users).values({
    id: userId,
    email: DEMO_EMAIL,
    name: "Demo Pilot",
    passwordHash,
    avatarColor: pickColor(DEMO_EMAIL),
  });

  const ws = await db.select().from(workspaces).limit(1);
  if (ws[0]) {
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws[0].id, userId, role: "member" })
      .onConflictDoNothing();
  }

  return { email: DEMO_EMAIL, password: DEMO_PASSWORD };
}
