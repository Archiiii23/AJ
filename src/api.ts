import { Hono } from "hono";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  auth,
  hashPassword,
  initialsFromName,
  pickColor,
  sessionCookie,
  expiredSessionCookie,
  verifyPassword,
} from "./auth";
import { getDb } from "./db";
import { getEnv } from "./context";
import { prefixedId, slugify } from "./ids";
import { logActivity } from "./activity";
import { runAi } from "./ai";
import { ensureDemoUser, seedIfEmpty } from "./seed";
import collabRoutes, {
  createCommentWithMentions,
  notifyAssignment,
  snapshotWikiVersion,
  publicUserFull,
} from "./routes-collab";
import integrationsRoutes, { postSlackForProject } from "./routes-integrations";
import {
  activity,
  notifications,
  projects,
  snippets,
  taskComments,
  taskLabels,
  tasks,
  users,
  wikiPages,
  workspaceMembers,
  workspaces,
  type User,
} from "./schema";

function cookieHints() {
  const env = getEnv();
  return env.SESSION_COOKIE_DOMAIN ? { domain: env.SESSION_COOKIE_DOMAIN } : {};
}

interface Variables {
  user: User;
  workspaceId: string;
}

const app = new Hono<{ Variables: Variables }>();

const ok = <T>(data: T, init?: ResponseInit) =>
  new Response(JSON.stringify({ data }), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });

const fail = (status: number, message: string, extra?: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: { message, ...extra } }), {
    status,
    headers: { "content-type": "application/json" },
  });

app.onError((err, _c) => {
  console.error("API error", err);
  if (err instanceof z.ZodError) {
    return fail(400, "Invalid request body", { issues: err.issues });
  }
  return fail(500, err instanceof Error ? err.message : "Internal error");
});

async function getActiveWorkspaceId(userId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function ensureProjectAccess(userId: string, projectId: string) {
  const rows = await getDb()
    .select({ project: projects, role: workspaceMembers.role })
    .from(projects)
    .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, projects.workspaceId))
    .where(and(eq(projects.id, projectId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function projectByIdOrSlug(workspaceId: string, idOrSlug: string) {
  const rows = await getDb()
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        or(eq(projects.id, idOrSlug), eq(projects.slug, idOrSlug)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarColor: u.avatarColor,
    initials: initialsFromName(u.name),
  };
}

async function attachLabelsAndAssignees(rows: (typeof tasks.$inferSelect)[]) {
  if (!rows.length) return [];
  const db = getDb();
  const ids = rows.map((r) => r.id);
  const assigneeIds = Array.from(
    new Set(rows.map((r) => r.assigneeId).filter((id): id is string => Boolean(id))),
  );
  const [labelRows, assigneeRows] = await Promise.all([
    db.select().from(taskLabels).where(inArray(taskLabels.taskId, ids)),
    assigneeIds.length
      ? db.select().from(users).where(inArray(users.id, assigneeIds))
      : Promise.resolve([] as User[]),
  ]);
  const labelMap = new Map<string, { name: string; tone: string }[]>();
  for (const l of labelRows) {
    const arr = labelMap.get(l.taskId) ?? [];
    arr.push({ name: l.name, tone: l.tone });
    labelMap.set(l.taskId, arr);
  }
  const assigneeMap = new Map(assigneeRows.map((u) => [u.id, publicUser(u)]));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    due: r.due,
    position: r.position,
    assignee: r.assigneeId ? (assigneeMap.get(r.assigneeId) ?? null) : null,
    labels: labelMap.get(r.id) ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// ============================================================
// PUBLIC: auth + bootstrap
// ============================================================

app.get("/health", (c) => c.json({ data: { ok: true } }));

app.post("/auth/bootstrap", async () => {
  const seed = await seedIfEmpty();
  const demo = await ensureDemoUser();
  return ok({ ...seed, demo });
});

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(80),
});

app.post("/auth/signup", async (c) => {
  await seedIfEmpty().catch(() => {});
  const body = signupSchema.parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email.toLowerCase()))
    .limit(1);
  if (existing.length) return fail(409, "An account with that email already exists.");

  const userId = auth.newUserId();
  const passwordHash = await hashPassword(body.password);
  await db.insert(users).values({
    id: userId,
    email: body.email.toLowerCase(),
    name: body.name.trim(),
    passwordHash,
    avatarColor: pickColor(body.email),
  });

  // Add new signups to the demo workspace as a member so they always see content.
  const workspaceId = await getActiveWorkspaceId(userId);
  if (!workspaceId) {
    const fallbackWs = await db.select().from(workspaces).limit(1);
    if (fallbackWs[0]) {
      await db
        .insert(workspaceMembers)
        .values({ workspaceId: fallbackWs[0].id, userId, role: "member" })
        .onConflictDoNothing();
    } else {
      const newWsId = prefixedId("ws");
      await db.insert(workspaces).values({
        id: newWsId,
        name: `${body.name.split(" ")[0]}'s workspace`,
        slug: slugify(body.name) + "-" + prefixedId("w", 4).slice(2),
        ownerId: userId,
      });
      await db.insert(workspaceMembers).values({ workspaceId: newWsId, userId, role: "owner" });
    }
  }

  const session = await auth.createSession(userId);
  const me = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  return new Response(JSON.stringify({ data: { user: publicUser(me) } }), {
    status: 201,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookie(session.id, c.req.raw, cookieHints()),
    },
  });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

app.post("/auth/login", async (c) => {
  await seedIfEmpty().catch(() => {});
  await ensureDemoUser().catch(() => {});
  const body = loginSchema.parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const row = (
    await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1)
  )[0];
  if (!row) return fail(401, "Invalid email or password.");
  const valid = await verifyPassword(body.password, row.passwordHash);
  if (!valid) return fail(401, "Invalid email or password.");
  const session = await auth.createSession(row.id);
  return new Response(JSON.stringify({ data: { user: publicUser(row) } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": sessionCookie(session.id, c.req.raw, cookieHints()),
    },
  });
});

app.post("/auth/logout", async (c) => {
  const sid = auth.readSessionCookie(c.req.raw);
  if (sid) await auth.deleteSession(sid).catch(() => {});
  return new Response(JSON.stringify({ data: { ok: true } }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": expiredSessionCookie(c.req.raw, cookieHints()),
    },
  });
});

app.get("/auth/me", async (c) => {
  const sid = auth.readSessionCookie(c.req.raw);
  const user = await auth.getSessionUser(sid);
  if (!user)
    return new Response(JSON.stringify({ data: { user: null } }), {
      headers: { "content-type": "application/json" },
    });
  return ok({ user: publicUser(user) });
});

// Public webhook endpoints (no auth — verified via provider signature).
// Mounted BEFORE the session middleware so external providers can reach them.
import publicWebhooks from "./routes-webhooks";
app.route("/", publicWebhooks);

// ============================================================
// AUTHED middleware: everything below requires a valid session
// ============================================================

app.use("*", async (c, next) => {
  const sid = auth.readSessionCookie(c.req.raw);
  const user = await auth.getSessionUser(sid);
  if (!user) return fail(401, "Not authenticated");
  c.set("user", user);
  const workspaceId = await getActiveWorkspaceId(user.id);
  if (workspaceId) c.set("workspaceId", workspaceId);
  return next();
});

// Mount the rest of the feature surface (members, invites, notifications,
// profile, snippet tags, wiki versions, attachments, billing, presence).
app.route("/", collabRoutes);

// Integrations (GitHub / Slack / Notion) — needs auth + workspaceId.
app.route("/", integrationsRoutes);

// Expose the extended profile via the existing /auth/me/full
// already mounted by collabRoutes. Re-export here for clarity.
export { publicUserFull };

// --- workspace ---

app.get("/workspaces", async (c) => {
  const user = c.get("user");
  const rows = await getDb()
    .select({ ws: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.id))
    .orderBy(asc(workspaces.createdAt));
  return ok({
    workspaces: rows.map((r) => ({ id: r.ws.id, name: r.ws.name, slug: r.ws.slug, role: r.role })),
    activeId: rows[0]?.ws.id ?? null,
  });
});

app.get("/workspace/summary", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return ok({ projects: [], openTasks: 0, overdue: 0, activeProjects: 0 });
  const db = getDb();
  const [projectRows, taskRows, memberRows] = await Promise.all([
    db.select().from(projects).where(eq(projects.workspaceId, wsId)),
    db
      .select({ status: tasks.status, projectId: tasks.projectId, due: tasks.due })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(projects.workspaceId, wsId)),
    db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, wsId)),
  ]);

  const openTasks = taskRows.filter((t) => t.status !== "done").length;
  const overdue = 0; // placeholder until real due dates are stored
  const byProject = new Map<string, number>();
  for (const t of taskRows) {
    if (t.status !== "done") byProject.set(t.projectId, (byProject.get(t.projectId) ?? 0) + 1);
  }

  return ok({
    activeProjects: projectRows.length,
    openTasks,
    overdue,
    memberCount: memberRows.length,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      color: p.color,
      openTasks: byProject.get(p.id) ?? 0,
      progress: (() => {
        const totals = taskRows.filter((t) => t.projectId === p.id);
        if (!totals.length) return 0;
        const done = totals.filter((t) => t.status === "done").length;
        return Math.round((done / totals.length) * 100);
      })(),
      members: memberRows.length,
    })),
  });
});

// --- projects ---

app.get("/projects", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return ok({ projects: [] });
  const rows = await getDb()
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, wsId))
    .orderBy(asc(projects.createdAt));
  return ok({ projects: rows });
});

const createProjectSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(280).optional(),
  color: z.string().optional(),
});

app.post("/projects", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "No active workspace");
  // Enforce free-tier 3-project cap.
  const ws = (await getDb().select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1))[0];
  if (ws?.tier !== "pro") {
    const count = (
      await getDb()
        .select({ n: sql<number>`count(*)` })
        .from(projects)
        .where(eq(projects.workspaceId, wsId))
    )[0]?.n;
    if (Number(count ?? 0) >= 3)
      return fail(
        402,
        "Free tier is capped at 3 projects per workspace. Upgrade to Pro for unlimited.",
      );
  }
  const body = createProjectSchema.parse(await c.req.json().catch(() => ({})));
  const id = prefixedId("prj");
  const project = {
    id,
    workspaceId: wsId,
    name: body.name.trim(),
    slug: slugify(body.name),
    description: body.description ?? "",
    color: body.color ?? pickColor(body.name),
  };
  await getDb().insert(projects).values(project);
  await logActivity({
    workspaceId: wsId,
    projectId: id,
    actorId: c.get("user").id,
    action: "created project",
    targetType: "project",
    targetId: id,
    targetLabel: project.name,
  });
  return ok({ project }, { status: 201 });
});

app.get("/projects/:idOrSlug", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  return ok({ project });
});

// --- tasks ---

const tasksQuery = z.object({
  status: z.string().optional(),
  assignee: z.string().optional(),
});

app.get("/projects/:idOrSlug/tasks", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const q = tasksQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const conditions = [eq(tasks.projectId, project.id)];
  if (q.status) conditions.push(eq(tasks.status, q.status as never));
  if (q.assignee) conditions.push(eq(tasks.assigneeId, q.assignee));
  const rows = await getDb()
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.position), desc(tasks.createdAt));
  return ok({ tasks: await attachLabelsAndAssignees(rows) });
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(140),
  description: z.string().max(4000).optional(),
  status: z.enum(["backlog", "todo", "in_progress", "review", "done"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().optional().nullable(),
  due: z.string().optional().nullable(),
  labels: z
    .array(
      z.object({
        name: z.string().min(1),
        tone: z.enum(["green", "blue", "yellow", "red", "gray"]),
      }),
    )
    .max(8)
    .optional(),
});

app.post("/projects/:idOrSlug/tasks", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const body = createTaskSchema.parse(await c.req.json().catch(() => ({})));
  const id = prefixedId("tsk");
  const db = getDb();
  const positionRow = await db
    .select({ p: sql<number>`coalesce(max(${tasks.position}), 0)` })
    .from(tasks)
    .where(eq(tasks.projectId, project.id));
  const nextPosition = (positionRow[0]?.p ?? 0) + 10;
  await db.insert(tasks).values({
    id,
    projectId: project.id,
    title: body.title,
    description: body.description ?? "",
    status: body.status ?? "todo",
    priority: body.priority ?? "medium",
    assigneeId: body.assigneeId ?? c.get("user").id,
    due: body.due ?? null,
    position: nextPosition,
    createdById: c.get("user").id,
  });
  if (body.labels?.length) {
    await db.insert(taskLabels).values(
      body.labels.map((l) => ({
        id: prefixedId("lbl"),
        taskId: id,
        name: l.name,
        tone: l.tone,
      })),
    );
  }
  await logActivity({
    workspaceId: wsId,
    projectId: project.id,
    actorId: c.get("user").id,
    action: "created task",
    targetType: "task",
    targetId: id,
    targetLabel: body.title,
  });
  const created = await db.select().from(tasks).where(eq(tasks.id, id));
  return ok({ task: (await attachLabelsAndAssignees(created))[0] }, { status: 201 });
});

const updateTaskSchema = createTaskSchema.partial();

app.patch("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const db = getDb();
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) return fail(404, "Task not found");
  const access = await ensureProjectAccess(user.id, row.projectId);
  if (!access) return fail(403, "Forbidden");
  const body = updateTaskSchema.parse(await c.req.json().catch(() => ({})));
  const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.status !== undefined) updates.status = body.status;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.assigneeId !== undefined) updates.assigneeId = body.assigneeId;
  if (body.due !== undefined) updates.due = body.due;
  await db.update(tasks).set(updates).where(eq(tasks.id, id));
  if (body.labels) {
    await db.delete(taskLabels).where(eq(taskLabels.taskId, id));
    if (body.labels.length) {
      await db.insert(taskLabels).values(
        body.labels.map((l) => ({
          id: prefixedId("lbl"),
          taskId: id,
          name: l.name,
          tone: l.tone,
        })),
      );
    }
  }
  // Notify on assignment change.
  if (body.assigneeId !== undefined && body.assigneeId && body.assigneeId !== row.assigneeId) {
    await notifyAssignment({
      taskId: id,
      taskTitle: body.title ?? row.title,
      assigneeId: body.assigneeId,
      actorId: user.id,
      workspaceId: wsId,
      projectId: row.projectId,
    }).catch((err) => console.error("notifyAssignment failed", err));
  }
  // Notify on status change to the assignee + Slack channels linked to the project.
  if (body.status && body.status !== row.status) {
    const actor = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0];
    if (row.assigneeId && row.assigneeId !== user.id) {
      await db
        .insert(notifications)
        .values({
          id: prefixedId("ntf"),
          userId: row.assigneeId,
          workspaceId: wsId,
          projectId: row.projectId,
          kind: "status_change",
          title: `${actor?.name ?? "Someone"} moved "${row.title}" to ${body.status.replace("_", " ")}`,
          body: "",
          targetType: "task",
          targetId: id,
          actorId: user.id,
        })
        .catch((err) => console.error("notify status_change failed", err));
    }
    // Fire-and-forget Slack message (no-op if no Slack integration linked)
    postSlackForProject(
      row.projectId,
      `:arrow_right: *${actor?.name ?? "Someone"}* moved *${row.title}* to *${body.status.replace("_", " ")}*`,
    ).catch((err) => console.error("slack post failed", err));
  }
  const action =
    body.status && body.status !== row.status
      ? `moved task to ${body.status.replace("_", " ")}`
      : "updated task";
  await logActivity({
    workspaceId: wsId,
    projectId: row.projectId,
    actorId: user.id,
    action,
    targetType: "task",
    targetId: id,
    targetLabel: body.title ?? row.title,
    meta: body.status ? { to: body.status } : undefined,
  });
  const fresh = await db.select().from(tasks).where(eq(tasks.id, id));
  return ok({ task: (await attachLabelsAndAssignees(fresh))[0] });
});

app.delete("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const db = getDb();
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) return fail(404, "Task not found");
  const access = await ensureProjectAccess(user.id, row.projectId);
  if (!access) return fail(403, "Forbidden");
  await db.delete(tasks).where(eq(tasks.id, id));
  await logActivity({
    workspaceId: wsId,
    projectId: row.projectId,
    actorId: user.id,
    action: "deleted task",
    targetType: "task",
    targetId: id,
    targetLabel: row.title,
  });
  return ok({ ok: true });
});

const bulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1),
  status: z.enum(["backlog", "todo", "in_progress", "review", "done"]).optional(),
  assigneeId: z.string().optional().nullable(),
});

app.post("/tasks/bulk", async (c) => {
  const body = bulkUpdateSchema.parse(await c.req.json().catch(() => ({})));
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const db = getDb();
  const rows = await db.select().from(tasks).where(inArray(tasks.id, body.ids));
  for (const row of rows) {
    const access = await ensureProjectAccess(user.id, row.projectId);
    if (!access) return fail(403, "Forbidden");
  }
  const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (body.status !== undefined) updates.status = body.status;
  if (body.assigneeId !== undefined) updates.assigneeId = body.assigneeId;
  await db.update(tasks).set(updates).where(inArray(tasks.id, body.ids));
  await logActivity({
    workspaceId: wsId,
    actorId: user.id,
    action: `bulk-updated ${body.ids.length} tasks`,
    targetType: "task",
    targetId: body.ids[0],
    targetLabel: `${body.ids.length} tasks`,
    meta: { ids: body.ids },
  });
  return ok({ ok: true, count: body.ids.length });
});

app.post("/tasks/bulk-delete", async (c) => {
  const body = z
    .object({ ids: z.array(z.string()).min(1) })
    .parse(await c.req.json().catch(() => ({})));
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const db = getDb();
  const rows = await db.select().from(tasks).where(inArray(tasks.id, body.ids));
  for (const row of rows) {
    const access = await ensureProjectAccess(user.id, row.projectId);
    if (!access) return fail(403, "Forbidden");
  }
  await db.delete(tasks).where(inArray(tasks.id, body.ids));
  await logActivity({
    workspaceId: wsId,
    actorId: user.id,
    action: `deleted ${body.ids.length} tasks`,
    targetType: "task",
    targetId: body.ids[0],
    targetLabel: `${body.ids.length} tasks`,
    meta: { ids: body.ids },
  });
  return ok({ ok: true, count: body.ids.length });
});

// --- task comments ---

app.get("/tasks/:id/comments", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const db = getDb();
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) return fail(404, "Task not found");
  if (!(await ensureProjectAccess(user.id, row.projectId))) return fail(403, "Forbidden");
  const comments = await db
    .select({ c: taskComments, u: users })
    .from(taskComments)
    .innerJoin(users, eq(users.id, taskComments.authorId))
    .where(eq(taskComments.taskId, id))
    .orderBy(asc(taskComments.createdAt));
  return ok({
    comments: comments.map((row) => ({
      id: row.c.id,
      content: row.c.content,
      createdAt: row.c.createdAt,
      author: publicUser(row.u),
    })),
  });
});

app.post("/tasks/:id/comments", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  const body = z
    .object({ content: z.string().min(1).max(2000) })
    .parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!row) return fail(404, "Task not found");
  if (!(await ensureProjectAccess(user.id, row.projectId))) return fail(403, "Forbidden");
  const commentId = await createCommentWithMentions({
    taskId: id,
    authorId: user.id,
    workspaceId: wsId,
    projectId: row.projectId,
    taskTitle: row.title,
    content: body.content,
  });
  if (wsId) {
    await logActivity({
      workspaceId: wsId,
      projectId: row.projectId,
      actorId: user.id,
      action: "commented on",
      targetType: "task",
      targetId: id,
      targetLabel: row.title,
    });
  }
  return ok({ commentId }, { status: 201 });
});

// --- wiki ---

app.get("/projects/:idOrSlug/wiki", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const rows = await getDb()
    .select({ p: wikiPages, author: users })
    .from(wikiPages)
    .innerJoin(users, eq(users.id, wikiPages.authorId))
    .where(eq(wikiPages.projectId, project.id))
    .orderBy(desc(wikiPages.updatedAt));
  return ok({
    pages: rows.map((row) => ({
      id: row.p.id,
      title: row.p.title,
      slug: row.p.slug,
      category: row.p.category,
      content: row.p.content,
      updatedAt: row.p.updatedAt,
      createdAt: row.p.createdAt,
      author: publicUser(row.author),
    })),
  });
});

const wikiPageSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(64_000),
  category: z.string().max(60).optional(),
});

app.post("/projects/:idOrSlug/wiki", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const body = wikiPageSchema.parse(await c.req.json().catch(() => ({})));
  const id = prefixedId("wik");
  await getDb()
    .insert(wikiPages)
    .values({
      id,
      projectId: project.id,
      title: body.title,
      slug: slugify(body.title),
      content: body.content,
      category: body.category ?? "General",
      authorId: c.get("user").id,
    });
  await logActivity({
    workspaceId: wsId,
    projectId: project.id,
    actorId: c.get("user").id,
    action: "created wiki page",
    targetType: "wiki",
    targetId: id,
    targetLabel: body.title,
  });
  return ok({ id }, { status: 201 });
});

app.patch("/wiki/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  const body = wikiPageSchema.partial().parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const row = (await db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1))[0];
  if (!row) return fail(404, "Wiki page not found");
  if (!(await ensureProjectAccess(user.id, row.projectId))) return fail(403, "Forbidden");
  // Snapshot the previous content as a version before applying changes.
  if (body.title !== undefined || body.content !== undefined || body.category !== undefined) {
    await snapshotWikiVersion(row, user.id).catch((err) =>
      console.error("snapshotWikiVersion failed", err),
    );
  }
  const updates: Partial<typeof wikiPages.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) {
    updates.title = body.title;
    updates.slug = slugify(body.title);
  }
  if (body.content !== undefined) updates.content = body.content;
  if (body.category !== undefined) updates.category = body.category;
  await db.update(wikiPages).set(updates).where(eq(wikiPages.id, id));
  if (wsId) {
    await logActivity({
      workspaceId: wsId,
      projectId: row.projectId,
      actorId: user.id,
      action: "updated wiki page",
      targetType: "wiki",
      targetId: id,
      targetLabel: body.title ?? row.title,
    });
  }
  return ok({ ok: true });
});

app.delete("/wiki/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  const db = getDb();
  const row = (await db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1))[0];
  if (!row) return fail(404, "Wiki page not found");
  if (!(await ensureProjectAccess(user.id, row.projectId))) return fail(403, "Forbidden");
  await db.delete(wikiPages).where(eq(wikiPages.id, id));
  if (wsId) {
    await logActivity({
      workspaceId: wsId,
      projectId: row.projectId,
      actorId: user.id,
      action: "deleted wiki page",
      targetType: "wiki",
      targetId: id,
      targetLabel: row.title,
    });
  }
  return ok({ ok: true });
});

// --- snippets ---

app.get("/projects/:idOrSlug/snippets", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const rows = await getDb()
    .select({ s: snippets, author: users })
    .from(snippets)
    .innerJoin(users, eq(users.id, snippets.authorId))
    .where(eq(snippets.projectId, project.id))
    .orderBy(desc(snippets.updatedAt));
  return ok({
    snippets: rows.map((row) => ({
      id: row.s.id,
      title: row.s.title,
      description: row.s.description,
      code: row.s.code,
      language: row.s.language,
      createdAt: row.s.createdAt,
      updatedAt: row.s.updatedAt,
      author: publicUser(row.author),
    })),
  });
});

const snippetSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(280).optional().default(""),
  code: z.string().min(1).max(32_000),
  language: z.string().min(1).max(40).default("typescript"),
});

app.post("/projects/:idOrSlug/snippets", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const body = snippetSchema.parse(await c.req.json().catch(() => ({})));
  const id = prefixedId("snp");
  await getDb()
    .insert(snippets)
    .values({
      id,
      projectId: project.id,
      title: body.title,
      description: body.description ?? "",
      code: body.code,
      language: body.language,
      authorId: c.get("user").id,
    });
  await logActivity({
    workspaceId: wsId,
    projectId: project.id,
    actorId: c.get("user").id,
    action: "added snippet",
    targetType: "snippet",
    targetId: id,
    targetLabel: body.title,
  });
  return ok({ id }, { status: 201 });
});

app.patch("/snippets/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  const body = snippetSchema.partial().parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const row = (await db.select().from(snippets).where(eq(snippets.id, id)).limit(1))[0];
  if (!row) return fail(404, "Snippet not found");
  if (!(await ensureProjectAccess(user.id, row.projectId))) return fail(403, "Forbidden");
  const updates: Partial<typeof snippets.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.code !== undefined) updates.code = body.code;
  if (body.language !== undefined) updates.language = body.language;
  await db.update(snippets).set(updates).where(eq(snippets.id, id));
  if (wsId) {
    await logActivity({
      workspaceId: wsId,
      projectId: row.projectId,
      actorId: user.id,
      action: "updated snippet",
      targetType: "snippet",
      targetId: id,
      targetLabel: body.title ?? row.title,
    });
  }
  return ok({ ok: true });
});

app.delete("/snippets/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  const db = getDb();
  const row = (await db.select().from(snippets).where(eq(snippets.id, id)).limit(1))[0];
  if (!row) return fail(404, "Snippet not found");
  if (!(await ensureProjectAccess(user.id, row.projectId))) return fail(403, "Forbidden");
  await db.delete(snippets).where(eq(snippets.id, id));
  if (wsId) {
    await logActivity({
      workspaceId: wsId,
      projectId: row.projectId,
      actorId: user.id,
      action: "deleted snippet",
      targetType: "snippet",
      targetId: id,
      targetLabel: row.title,
    });
  }
  return ok({ ok: true });
});

// --- activity feed ---

app.get("/activity", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return ok({ events: [] });
  const limit = Math.min(50, Number(new URL(c.req.url).searchParams.get("limit") ?? 20));
  const rows = await getDb()
    .select({ a: activity, actor: users })
    .from(activity)
    .innerJoin(users, eq(users.id, activity.actorId))
    .where(eq(activity.workspaceId, wsId))
    .orderBy(desc(activity.createdAt))
    .limit(limit);
  return ok({
    events: rows.map((row) => ({
      id: row.a.id,
      action: row.a.action,
      targetType: row.a.targetType,
      targetId: row.a.targetId,
      targetLabel: row.a.targetLabel,
      meta: row.a.meta ? safeJson(row.a.meta) : null,
      createdAt: row.a.createdAt,
      actor: publicUser(row.actor),
    })),
  });
});

// --- search ---

app.get("/search", async (c) => {
  const wsId = c.get("workspaceId");
  const q = new URL(c.req.url).searchParams.get("q")?.trim() ?? "";
  if (!wsId || !q) return ok({ wiki: [], snippets: [], tasks: [] });
  const term = `%${q.toLowerCase()}%`;
  const db = getDb();
  const [wikiHits, snippetHits, taskHits] = await Promise.all([
    db
      .select({ p: wikiPages })
      .from(wikiPages)
      .innerJoin(projects, eq(projects.id, wikiPages.projectId))
      .where(
        and(
          eq(projects.workspaceId, wsId),
          or(
            like(sql`lower(${wikiPages.title})`, term),
            like(sql`lower(${wikiPages.content})`, term),
          ),
        ),
      )
      .limit(8),
    db
      .select({ s: snippets })
      .from(snippets)
      .innerJoin(projects, eq(projects.id, snippets.projectId))
      .where(
        and(
          eq(projects.workspaceId, wsId),
          or(
            like(sql`lower(${snippets.title})`, term),
            like(sql`lower(${snippets.description})`, term),
            like(sql`lower(${snippets.code})`, term),
          ),
        ),
      )
      .limit(8),
    db
      .select({ t: tasks, projectSlug: projects.slug, projectId: projects.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(projects.workspaceId, wsId),
          or(like(sql`lower(${tasks.title})`, term), like(sql`lower(${tasks.id})`, term)),
        ),
      )
      .limit(8),
  ]);
  return ok({
    wiki: wikiHits.map(({ p }) => ({
      id: p.id,
      title: p.title,
      preview: p.content.slice(0, 80),
      projectId: p.projectId,
    })),
    snippets: snippetHits.map(({ s }) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      language: s.language,
      projectId: s.projectId,
    })),
    tasks: taskHits.map(({ t, projectSlug, projectId }) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      projectId,
      projectSlug,
    })),
  });
});

// --- ai ---

const aiSchema = z.object({
  kind: z.enum([
    "summary",
    "explain",
    "standup",
    "refactor",
    "db",
    "architecture",
    "chat",
    "code-review",
    "task-breakdown",
    "blockers",
  ]),
  platform: z.enum(["gemini", "claude", "gpt"]).optional(),
  prompt: z.string().min(1).max(8000),
  context: z.string().max(20_000).optional(),
});

app.post("/ai/run", async (c) => {
  const body = aiSchema.parse(await c.req.json().catch(() => ({})));
  const result = await runAi(body, c.get("user").id);
  return ok(result);
});

app.get("/ai/runs", async (c) => {
  const limit = Math.min(50, Number(new URL(c.req.url).searchParams.get("limit") ?? 10));
  const rows = await getDb()
    .select()
    .from(activity)
    .where(eq(activity.actorId, c.get("user").id))
    .orderBy(desc(activity.createdAt))
    .limit(limit);
  return ok({ runs: rows });
});

// --- helpers ---

function safeJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export default app;
