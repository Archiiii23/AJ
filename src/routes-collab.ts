/**
 * routes-collab.ts
 *
 * Adds the rest of the DevCollab feature surface on top of api.ts:
 *  - workspace members + invites (role-based)
 *  - notifications inbox
 *  - task comments with @mention parsing  (the POST is also overridden in api.ts → routed here)
 *  - user profile read/update
 *  - snippet tags
 *  - wiki versions (history + revert)
 *  - billing tier + sandbox checkout + free-tier limits helper
 *  - members directory (used by mention autocomplete)
 *
 * Mounted from api.ts via `app.route("/", collabRoutes)`.
 */

import { Hono } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "./db";
import { prefixedId } from "./ids";
import { initialsFromName, hashPassword, verifyPassword } from "./auth";
import { logActivity } from "./activity";
import {
  notifications,
  projects,
  snippets,
  snippetTags,
  taskAttachments,
  taskComments,
  tasks,
  users,
  wikiPages,
  wikiVersions,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  type User,
} from "./schema";

interface Variables {
  user: User;
  workspaceId: string;
}

const router = new Hono<{ Variables: Variables }>();

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

// ----- shared helpers (kept in sync with api.ts) -----

type Role = "owner" | "admin" | "member" | "viewer";
const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarColor: u.avatarColor,
    avatarUrl: u.avatarUrl,
    initials: initialsFromName(u.name),
  };
}

export function publicUserFull(u: User) {
  let skills: string[] = [];
  try {
    const parsed = JSON.parse(u.skills);
    if (Array.isArray(parsed)) skills = parsed.map(String).slice(0, 20);
  } catch {
    skills = [];
  }
  return {
    ...publicUser(u),
    bio: u.bio,
    skills,
    githubUrl: u.githubUrl,
  };
}

export async function getUserRole(workspaceId: string, userId: string): Promise<Role | null> {
  const row = await getDb()
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .limit(1);
  return (row[0]?.role as Role | undefined) ?? null;
}

export function roleAtLeast(role: Role | null, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export async function ensureRole(c: { get: (k: "user") => User; get2?: never }, workspaceId: string, min: Role) {
  const user = c.get("user");
  const role = await getUserRole(workspaceId, user.id);
  if (!roleAtLeast(role, min)) {
    return { ok: false as const, response: fail(403, `Requires ${min} or higher`) };
  }
  return { ok: true as const, role: role as Role };
}

async function projectByIdOrSlug(workspaceId: string, idOrSlug: string) {
  const rows = await getDb()
    .select()
    .from(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), sql`(${projects.id} = ${idOrSlug} OR ${projects.slug} = ${idOrSlug})`),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ============================================================
// MEMBERS
// ============================================================

router.get("/workspace/members", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return ok({ members: [] });
  const rows = await getDb()
    .select({ user: users, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, wsId))
    .orderBy(asc(workspaceMembers.createdAt));
  return ok({
    members: rows.map((r) => ({
      ...publicUserFull(r.user),
      role: r.role as Role,
      joinedAt: r.joinedAt,
    })),
  });
});

const updateRoleSchema = z.object({
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

router.patch("/workspace/members/:userId", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const gate = await ensureRole(c, wsId, "admin");
  if (!gate.ok) return gate.response;
  const targetId = c.req.param("userId");
  const body = updateRoleSchema.parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  // Only owner can promote to/from owner.
  if (body.role === "owner" && gate.role !== "owner") return fail(403, "Only an owner can promote to owner.");
  const existing = (
    await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetId)))
      .limit(1)
  )[0];
  if (!existing) return fail(404, "Member not found");
  if (existing.role === "owner" && gate.role !== "owner") return fail(403, "Only owner can demote owner.");
  await db
    .update(workspaceMembers)
    .set({ role: body.role })
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetId)));
  await logActivity({
    workspaceId: wsId,
    actorId: c.get("user").id,
    action: `changed role to ${body.role}`,
    targetType: "member",
    targetId,
    targetLabel: targetId,
  });
  return ok({ ok: true });
});

router.delete("/workspace/members/:userId", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const gate = await ensureRole(c, wsId, "admin");
  if (!gate.ok) return gate.response;
  const targetId = c.req.param("userId");
  const db = getDb();
  const target = (
    await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetId)))
      .limit(1)
  )[0];
  if (!target) return fail(404, "Member not found");
  if (target.role === "owner") return fail(403, "Cannot remove the workspace owner.");
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.userId, targetId)));
  return ok({ ok: true });
});

// ============================================================
// INVITES
// ============================================================

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member", "viewer"]).optional().default("member"),
});

router.get("/workspace/invites", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return ok({ invites: [] });
  const gate = await ensureRole(c, wsId, "admin");
  if (!gate.ok) return gate.response;
  const rows = await getDb()
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.workspaceId, wsId))
    .orderBy(desc(workspaceInvites.createdAt));
  return ok({
    invites: rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      token: r.token,
      acceptedAt: r.acceptedAt,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    })),
  });
});

router.post("/workspace/invites", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const gate = await ensureRole(c, wsId, "admin");
  if (!gate.ok) return gate.response;
  // Free-tier member cap: 5 (including pending invites).
  const ws = (await getDb().select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1))[0];
  if (ws?.tier === "free") {
    const [memberCountRow, pendingCountRow] = await Promise.all([
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, wsId)),
      getDb()
        .select({ n: sql<number>`count(*)` })
        .from(workspaceInvites)
        .where(and(eq(workspaceInvites.workspaceId, wsId), sql`${workspaceInvites.acceptedAt} IS NULL`)),
    ]);
    const total = Number(memberCountRow[0]?.n ?? 0) + Number(pendingCountRow[0]?.n ?? 0);
    if (total >= 5)
      return fail(402, "Free tier is capped at 5 members. Upgrade to Pro to invite more teammates.");
  }

  const body = inviteSchema.parse(await c.req.json().catch(() => ({})));
  const id = prefixedId("inv");
  const token = prefixedId("itk", 24);
  const db = getDb();
  await db.insert(workspaceInvites).values({
    id,
    workspaceId: wsId,
    email: body.email.toLowerCase(),
    role: body.role,
    token,
    invitedById: c.get("user").id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14), // 14 days
  });

  // If a user with this email exists, also create a notification for them.
  const target = (await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1))[0];
  if (target) {
    await db.insert(notifications).values({
      id: prefixedId("ntf"),
      userId: target.id,
      workspaceId: wsId,
      kind: "invite",
      title: `You were invited to ${ws?.name ?? "a workspace"}`,
      body: `Invited as ${body.role}.`,
      targetType: "invite",
      targetId: id,
      actorId: c.get("user").id,
      meta: JSON.stringify({ token, role: body.role }),
    });
  }

  await logActivity({
    workspaceId: wsId,
    actorId: c.get("user").id,
    action: "invited",
    targetType: "invite",
    targetId: id,
    targetLabel: body.email,
    meta: { role: body.role },
  });
  return ok({ id, token }, { status: 201 });
});

router.delete("/workspace/invites/:id", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const gate = await ensureRole(c, wsId, "admin");
  if (!gate.ok) return gate.response;
  await getDb()
    .delete(workspaceInvites)
    .where(and(eq(workspaceInvites.id, c.req.param("id")), eq(workspaceInvites.workspaceId, wsId)));
  return ok({ ok: true });
});

router.post("/invites/accept", async (c) => {
  const body = z.object({ token: z.string().min(4) }).parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const invite = (
    await db.select().from(workspaceInvites).where(eq(workspaceInvites.token, body.token)).limit(1)
  )[0];
  if (!invite) return fail(404, "Invite not found");
  if (invite.acceptedAt) return fail(410, "Invite already accepted");
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) return fail(410, "Invite expired");

  const user = c.get("user");
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: invite.workspaceId, userId: user.id, role: invite.role })
    .onConflictDoNothing();
  await db
    .update(workspaceInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(workspaceInvites.id, invite.id));
  await logActivity({
    workspaceId: invite.workspaceId,
    actorId: user.id,
    action: "joined workspace",
    targetType: "member",
    targetId: user.id,
    targetLabel: user.name,
  });
  return ok({ workspaceId: invite.workspaceId, role: invite.role });
});

// ============================================================
// NOTIFICATIONS
// ============================================================

router.get("/notifications", async (c) => {
  const user = c.get("user");
  const limit = Math.min(50, Number(new URL(c.req.url).searchParams.get("limit") ?? 25));
  const rows = await getDb()
    .select({ n: notifications, actor: users })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorId))
    .where(eq(notifications.userId, user.id))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  const unread = await getDb()
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, user.id), sql`${notifications.readAt} IS NULL`));
  return ok({
    notifications: rows.map((r) => ({
      id: r.n.id,
      kind: r.n.kind,
      title: r.n.title,
      body: r.n.body,
      targetType: r.n.targetType,
      targetId: r.n.targetId,
      workspaceId: r.n.workspaceId,
      projectId: r.n.projectId,
      readAt: r.n.readAt,
      createdAt: r.n.createdAt,
      meta: r.n.meta ? safeJson(r.n.meta) : null,
      actor: r.actor ? publicUser(r.actor) : null,
    })),
    unread: Number(unread[0]?.n ?? 0),
  });
});

router.post("/notifications/:id/read", async (c) => {
  const user = c.get("user");
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, c.req.param("id")), eq(notifications.userId, user.id)));
  return ok({ ok: true });
});

router.post("/notifications/read-all", async (c) => {
  const user = c.get("user");
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, user.id), sql`${notifications.readAt} IS NULL`));
  return ok({ ok: true });
});

// ============================================================
// USER PROFILE
// ============================================================

router.get("/auth/me/full", async (c) => {
  return ok({ user: publicUserFull(c.get("user")) });
});

const profileSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  bio: z.string().max(1000).optional(),
  skills: z.array(z.string().min(1).max(40)).max(20).optional(),
  githubUrl: z
    .string()
    .max(200)
    .optional()
    .refine((v) => !v || /^https?:\/\//.test(v) || v.startsWith("github.com/"), {
      message: "Must be a URL",
    }),
  avatarUrl: z.string().max(500).optional().nullable(),
});

router.patch("/auth/me", async (c) => {
  const user = c.get("user");
  const body = profileSchema.parse(await c.req.json().catch(() => ({})));
  const updates: Partial<typeof users.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.bio !== undefined) updates.bio = body.bio;
  if (body.skills !== undefined) updates.skills = JSON.stringify(body.skills);
  if (body.githubUrl !== undefined) updates.githubUrl = body.githubUrl;
  if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl ?? null;
  if (!Object.keys(updates).length) return ok({ user: publicUserFull(user) });
  await getDb().update(users).set(updates).where(eq(users.id, user.id));
  const fresh = (await getDb().select().from(users).where(eq(users.id, user.id)).limit(1))[0];
  return ok({ user: publicUserFull(fresh) });
});

router.post("/auth/me/password", async (c) => {
  const user = c.get("user");
  const body = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8).max(200),
    })
    .parse(await c.req.json().catch(() => ({})));
  const fresh = (await getDb().select().from(users).where(eq(users.id, user.id)).limit(1))[0];
  if (!fresh) return fail(404, "User missing");
  const okPw = await verifyPassword(body.currentPassword, fresh.passwordHash);
  if (!okPw) return fail(403, "Current password is incorrect.");
  const newHash = await hashPassword(body.newPassword);
  await getDb().update(users).set({ passwordHash: newHash }).where(eq(users.id, user.id));
  return ok({ ok: true });
});

// ============================================================
// COMMENTS with @mention parsing (called by api.ts override)
// ============================================================

const MENTION_RE = /@([A-Za-z0-9_.-]+)/g;

export async function createCommentWithMentions(opts: {
  taskId: string;
  authorId: string;
  workspaceId: string | undefined;
  projectId: string;
  taskTitle: string;
  content: string;
}) {
  const db = getDb();
  const commentId = prefixedId("cmt");
  await db.insert(taskComments).values({
    id: commentId,
    taskId: opts.taskId,
    authorId: opts.authorId,
    content: opts.content,
  });

  // Parse @mentions and create notifications for the mentioned users (must be workspace members).
  const handles = Array.from(new Set([...opts.content.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase())));
  if (handles.length && opts.workspaceId) {
    const candidates = await db
      .select({ user: users })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, opts.workspaceId));
    const mentioned = candidates
      .map((c) => c.user)
      .filter((u) => {
        const emailLocal = u.email.split("@")[0].toLowerCase();
        const nameSlug = u.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "");
        return handles.includes(emailLocal) || handles.includes(nameSlug);
      });
    if (mentioned.length) {
      const author = (await db.select().from(users).where(eq(users.id, opts.authorId)).limit(1))[0];
      const preview = opts.content.slice(0, 140);
      for (const m of mentioned) {
        if (m.id === opts.authorId) continue;
        await db.insert(notifications).values({
          id: prefixedId("ntf"),
          userId: m.id,
          workspaceId: opts.workspaceId,
          projectId: opts.projectId,
          kind: "mention",
          title: `${author?.name ?? "Someone"} mentioned you on "${opts.taskTitle}"`,
          body: preview,
          targetType: "task",
          targetId: opts.taskId,
          actorId: opts.authorId,
        });
      }
    }
  }

  return commentId;
}

// Also notify on assignment from the task PATCH flow.
export async function notifyAssignment(opts: {
  taskId: string;
  taskTitle: string;
  assigneeId: string;
  actorId: string;
  workspaceId: string;
  projectId: string;
}) {
  if (opts.assigneeId === opts.actorId) return;
  const actor = (await getDb().select().from(users).where(eq(users.id, opts.actorId)).limit(1))[0];
  await getDb()
    .insert(notifications)
    .values({
      id: prefixedId("ntf"),
      userId: opts.assigneeId,
      workspaceId: opts.workspaceId,
      projectId: opts.projectId,
      kind: "assignment",
      title: `${actor?.name ?? "Someone"} assigned "${opts.taskTitle}" to you`,
      body: "",
      targetType: "task",
      targetId: opts.taskId,
      actorId: opts.actorId,
    });
}

// ============================================================
// SNIPPET TAGS
// ============================================================

router.get("/projects/:idOrSlug/snippets-with-tags", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const project = await projectByIdOrSlug(wsId, c.req.param("idOrSlug"));
  if (!project) return fail(404, "Project not found");
  const db = getDb();
  const rows = await db
    .select({ s: snippets, author: users })
    .from(snippets)
    .innerJoin(users, eq(users.id, snippets.authorId))
    .where(eq(snippets.projectId, project.id))
    .orderBy(desc(snippets.updatedAt));
  if (!rows.length) return ok({ snippets: [] });
  const ids = rows.map((r) => r.s.id);
  const tagRows = await db.select().from(snippetTags).where(inArray(snippetTags.snippetId, ids));
  const tagMap = new Map<string, string[]>();
  for (const t of tagRows) {
    const arr = tagMap.get(t.snippetId) ?? [];
    arr.push(t.name);
    tagMap.set(t.snippetId, arr);
  }
  return ok({
    snippets: rows.map((row) => ({
      id: row.s.id,
      title: row.s.title,
      description: row.s.description,
      code: row.s.code,
      language: row.s.language,
      tags: tagMap.get(row.s.id) ?? [],
      createdAt: row.s.createdAt,
      updatedAt: row.s.updatedAt,
      author: publicUser(row.author),
    })),
  });
});

const tagsSchema = z.object({ tags: z.array(z.string().min(1).max(40)).max(20) });

router.put("/snippets/:id/tags", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const snippet = (await db.select().from(snippets).where(eq(snippets.id, id)).limit(1))[0];
  if (!snippet) return fail(404, "Snippet not found");
  const project = (await db.select().from(projects).where(eq(projects.id, snippet.projectId)).limit(1))[0];
  if (!project) return fail(404, "Project missing");
  const role = await getUserRole(project.workspaceId, c.get("user").id);
  if (!roleAtLeast(role, "member")) return fail(403, "Forbidden");
  const body = tagsSchema.parse(await c.req.json().catch(() => ({})));
  await db.delete(snippetTags).where(eq(snippetTags.snippetId, id));
  if (body.tags.length) {
    await db
      .insert(snippetTags)
      .values(body.tags.map((name) => ({ id: prefixedId("stg"), snippetId: id, name: name.toLowerCase() })));
  }
  return ok({ tags: body.tags.map((t) => t.toLowerCase()) });
});

// ============================================================
// WIKI VERSIONS
// ============================================================

router.get("/wiki/:id/versions", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const page = (await db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1))[0];
  if (!page) return fail(404, "Wiki page not found");
  const project = (await db.select().from(projects).where(eq(projects.id, page.projectId)).limit(1))[0];
  if (!project) return fail(404, "Project missing");
  const role = await getUserRole(project.workspaceId, c.get("user").id);
  if (!role) return fail(403, "Forbidden");
  const rows = await db
    .select({ v: wikiVersions, author: users })
    .from(wikiVersions)
    .innerJoin(users, eq(users.id, wikiVersions.authorId))
    .where(eq(wikiVersions.pageId, id))
    .orderBy(desc(wikiVersions.createdAt))
    .limit(50);
  return ok({
    versions: rows.map((row) => ({
      id: row.v.id,
      title: row.v.title,
      content: row.v.content,
      category: row.v.category,
      createdAt: row.v.createdAt,
      author: publicUser(row.author),
    })),
  });
});

router.post("/wiki/:id/revert", async (c) => {
  const id = c.req.param("id");
  const body = z.object({ versionId: z.string() }).parse(await c.req.json().catch(() => ({})));
  const db = getDb();
  const page = (await db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1))[0];
  if (!page) return fail(404, "Wiki page not found");
  const project = (await db.select().from(projects).where(eq(projects.id, page.projectId)).limit(1))[0];
  if (!project) return fail(404, "Project missing");
  const role = await getUserRole(project.workspaceId, c.get("user").id);
  if (!roleAtLeast(role, "member")) return fail(403, "Forbidden");
  const version = (await db.select().from(wikiVersions).where(eq(wikiVersions.id, body.versionId)).limit(1))[0];
  if (!version || version.pageId !== id) return fail(404, "Version not found");

  // Snapshot current state into a new version BEFORE overwriting.
  await db.insert(wikiVersions).values({
    id: prefixedId("wkv"),
    pageId: id,
    title: page.title,
    content: page.content,
    category: page.category,
    authorId: c.get("user").id,
  });
  await db
    .update(wikiPages)
    .set({
      title: version.title,
      content: version.content,
      category: version.category,
      updatedAt: new Date(),
    })
    .where(eq(wikiPages.id, id));
  return ok({ ok: true });
});

// Helper used by wiki PATCH override in api.ts.
export async function snapshotWikiVersion(page: typeof wikiPages.$inferSelect, authorId: string) {
  await getDb()
    .insert(wikiVersions)
    .values({
      id: prefixedId("wkv"),
      pageId: page.id,
      title: page.title,
      content: page.content,
      category: page.category,
      authorId,
    });
}

// ============================================================
// TASK ATTACHMENTS
// ============================================================

router.get("/tasks/:id/attachments", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const task = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!task) return fail(404, "Task not found");
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1))[0];
  if (!project) return fail(404, "Project missing");
  const role = await getUserRole(project.workspaceId, c.get("user").id);
  if (!role) return fail(403, "Forbidden");
  const rows = await db
    .select({ a: taskAttachments, uploader: users })
    .from(taskAttachments)
    .innerJoin(users, eq(users.id, taskAttachments.uploadedById))
    .where(eq(taskAttachments.taskId, id))
    .orderBy(desc(taskAttachments.createdAt));
  return ok({
    attachments: rows.map((row) => ({
      id: row.a.id,
      url: row.a.url,
      name: row.a.name,
      size: row.a.size,
      mime: row.a.mime,
      createdAt: row.a.createdAt,
      uploader: publicUser(row.uploader),
    })),
  });
});

const attachmentSchema = z.object({
  url: z.string().min(1).max(2000),
  name: z.string().min(1).max(200),
  size: z.number().int().nonnegative().optional(),
  mime: z.string().max(120).optional(),
});

router.post("/tasks/:id/attachments", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const task = (await db.select().from(tasks).where(eq(tasks.id, id)).limit(1))[0];
  if (!task) return fail(404, "Task not found");
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1))[0];
  if (!project) return fail(404, "Project missing");
  const role = await getUserRole(project.workspaceId, c.get("user").id);
  if (!roleAtLeast(role, "member")) return fail(403, "Forbidden");
  const body = attachmentSchema.parse(await c.req.json().catch(() => ({})));
  const attId = prefixedId("att");
  await db.insert(taskAttachments).values({
    id: attId,
    taskId: id,
    url: body.url,
    name: body.name,
    size: body.size ?? 0,
    mime: body.mime ?? "",
    uploadedById: c.get("user").id,
  });
  return ok({ id: attId }, { status: 201 });
});

router.delete("/tasks/:taskId/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = (await db.select().from(taskAttachments).where(eq(taskAttachments.id, id)).limit(1))[0];
  if (!row) return fail(404, "Attachment not found");
  const task = (await db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1))[0];
  if (!task) return fail(404, "Task not found");
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId)).limit(1))[0];
  if (!project) return fail(404, "Project missing");
  const role = await getUserRole(project.workspaceId, c.get("user").id);
  if (!roleAtLeast(role, "member")) return fail(403, "Forbidden");
  await db.delete(taskAttachments).where(eq(taskAttachments.id, id));
  return ok({ ok: true });
});

// ============================================================
// BILLING (sandbox)
// ============================================================

router.get("/billing", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const ws = (await getDb().select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1))[0];
  if (!ws) return fail(404, "Workspace missing");
  const [projectsCountRow, membersCountRow] = await Promise.all([
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(projects)
      .where(eq(projects.workspaceId, wsId)),
    getDb()
      .select({ n: sql<number>`count(*)` })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, wsId)),
  ]);
  const limits =
    ws.tier === "pro"
      ? { workspaces: Infinity, projects: Infinity, members: Infinity }
      : { workspaces: 1, projects: 3, members: 5 };
  return ok({
    tier: ws.tier,
    tierUpdatedAt: ws.tierUpdatedAt,
    usage: {
      projects: Number(projectsCountRow[0]?.n ?? 0),
      members: Number(membersCountRow[0]?.n ?? 0),
    },
    limits: {
      projects: Number.isFinite(limits.projects) ? limits.projects : null,
      members: Number.isFinite(limits.members) ? limits.members : null,
    },
  });
});

const checkoutSchema = z.object({
  plan: z.enum(["pro", "free"]),
  // Sandbox card numbers — pretend payment.
  card: z
    .object({
      number: z.string().min(8).max(20),
      cvc: z.string().min(3).max(4),
      exp: z.string().min(4).max(7),
    })
    .optional(),
});

router.post("/billing/checkout", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(404, "Workspace missing");
  const gate = await ensureRole(c, wsId, "admin");
  if (!gate.ok) return gate.response;
  const body = checkoutSchema.parse(await c.req.json().catch(() => ({})));
  await getDb()
    .update(workspaces)
    .set({ tier: body.plan, tierUpdatedAt: new Date() })
    .where(eq(workspaces.id, wsId));
  await logActivity({
    workspaceId: wsId,
    actorId: c.get("user").id,
    action: body.plan === "pro" ? "upgraded to Pro" : "downgraded to Free",
    targetType: "billing",
    targetId: wsId,
    targetLabel: body.plan,
  });
  return ok({
    ok: true,
    tier: body.plan,
    sandbox: true,
    receiptId: `rct_${Math.random().toString(36).slice(2, 10)}`,
  });
});

// ============================================================
// PRESENCE (HTTP fallback when WebSockets unavailable)
// ============================================================

const PRESENCE_TTL_MS = 30_000;
// In-memory presence per Worker isolate. Eventually-consistent across isolates,
// which is fine for "who's looking at this board" — the Durable Object path
// (when wired) would replace this.
const presenceMap = new Map<string, Map<string, { name: string; color: string; at: number }>>();

router.post("/presence/:projectId/heartbeat", async (c) => {
  const projectId = c.req.param("projectId");
  const user = c.get("user");
  const key = `prj:${projectId}`;
  const room = presenceMap.get(key) ?? new Map();
  room.set(user.id, { name: user.name, color: user.avatarColor, at: Date.now() });
  // Sweep stale.
  for (const [k, v] of room) if (Date.now() - v.at > PRESENCE_TTL_MS) room.delete(k);
  presenceMap.set(key, room);
  return ok({ ok: true });
});

router.get("/presence/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const key = `prj:${projectId}`;
  const room = presenceMap.get(key) ?? new Map();
  for (const [k, v] of room) if (Date.now() - v.at > PRESENCE_TTL_MS) room.delete(k);
  return ok({
    users: Array.from(room.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      color: p.color,
      initials: initialsFromName(p.name),
      lastSeen: p.at,
    })),
  });
});

// ============================================================
// helpers
// ============================================================

function safeJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export default router;
