import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

const ts = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
const upd = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  avatarColor: text("avatar_color").notNull().default("oklch(0.65 0.14 240)"),
  avatarUrl: text("avatar_url"),
  bio: text("bio").notNull().default(""),
  skills: text("skills").notNull().default("[]"), // JSON array
  githubUrl: text("github_url").notNull().default(""),
  createdAt: ts(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tier: text("tier", { enum: ["free", "pro"] }).notNull().default("free"),
  tierUpdatedAt: integer("tier_updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`0`),
  createdAt: ts(),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    createdAt: ts(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("oklch(0.58 0.15 155)"),
    createdAt: ts(),
  },
  (t) => [index("projects_workspace_idx").on(t.workspaceId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", {
      enum: ["backlog", "todo", "in_progress", "review", "done"],
    })
      .notNull()
      .default("backlog"),
    priority: text("priority", {
      enum: ["low", "medium", "high", "urgent"],
    })
      .notNull()
      .default("medium"),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    due: text("due"),
    position: integer("position").notNull().default(0),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
    updatedAt: upd(),
  },
  (t) => [
    index("tasks_project_status_idx").on(t.projectId, t.status),
    index("tasks_assignee_idx").on(t.assigneeId),
  ],
);

export const taskLabels = sqliteTable(
  "task_labels",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tone: text("tone", { enum: ["green", "blue", "yellow", "red", "gray"] }).notNull(),
  },
  (t) => [index("task_labels_task_idx").on(t.taskId)],
);

export const taskComments = sqliteTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: ts(),
  },
  (t) => [index("task_comments_task_idx").on(t.taskId)],
);

export const wikiPages = sqliteTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    content: text("content").notNull().default(""),
    category: text("category").notNull().default("General"),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
    updatedAt: upd(),
  },
  (t) => [index("wiki_pages_project_idx").on(t.projectId)],
);

export const snippets = sqliteTable(
  "snippets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    code: text("code").notNull(),
    language: text("language").notNull().default("typescript"),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
    updatedAt: upd(),
  },
  (t) => [index("snippets_project_idx").on(t.projectId)],
);

export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    targetLabel: text("target_label").notNull(),
    meta: text("meta"),
    createdAt: ts(),
  },
  (t) => [index("activity_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const aiRuns = sqliteTable(
  "ai_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    input: text("input").notNull(),
    output: text("output").notNull(),
    model: text("model").notNull(),
    createdAt: ts(),
  },
  (t) => [index("ai_runs_user_idx").on(t.userId, t.createdAt)],
);

export const workspaceInvites = sqliteTable(
  "workspace_invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] })
      .notNull()
      .default("member"),
    token: text("token").notNull().unique(),
    invitedById: text("invited_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts(),
  },
  (t) => [
    index("workspace_invites_workspace_idx").on(t.workspaceId),
    index("workspace_invites_email_idx").on(t.email),
  ],
);

export const snippetTags = sqliteTable(
  "snippet_tags",
  {
    id: text("id").primaryKey(),
    snippetId: text("snippet_id")
      .notNull()
      .references(() => snippets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [
    index("snippet_tags_snippet_idx").on(t.snippetId),
    index("snippet_tags_name_idx").on(t.name),
  ],
);

export const wikiVersions = sqliteTable(
  "wiki_versions",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
  },
  (t) => [index("wiki_versions_page_idx").on(t.pageId, t.createdAt)],
);

export const taskAttachments = sqliteTable(
  "task_attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull().default(0),
    mime: text("mime").notNull().default(""),
    uploadedById: text("uploaded_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
  },
  (t) => [index("task_attachments_task_idx").on(t.taskId)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    meta: text("meta"),
    createdAt: ts(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    index("notifications_user_unread_idx").on(t.userId, t.readAt),
  ],
);

export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["github", "slack", "notion"] }).notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    scope: text("scope").notNull().default(""),
    accountId: text("account_id").notNull().default(""),
    accountName: text("account_name").notNull().default(""),
    accountAvatar: text("account_avatar").notNull().default(""),
    webhookUrl: text("webhook_url").notNull().default(""),
    webhookSecret: text("webhook_secret").notNull().default(""),
    meta: text("meta").notNull().default("{}"),
    connectedById: text("connected_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: ts(),
    updatedAt: upd(),
  },
  (t) => [index("integrations_workspace_kind_idx").on(t.workspaceId, t.kind)],
);

export const integrationLinks = sqliteTable(
  "integration_links",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    externalName: text("external_name").notNull().default(""),
    externalUrl: text("external_url").notNull().default(""),
    meta: text("meta").notNull().default("{}"),
    createdAt: ts(),
  },
  (t) => [
    index("integration_links_project_idx").on(t.projectId),
    index("integration_links_integration_idx").on(t.integrationId),
  ],
);

export const oauthStates = sqliteTable(
  "oauth_states",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    returnTo: text("return_to").notNull().default(""),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: ts(),
  },
  (t) => [index("oauth_states_user_idx").on(t.userId, t.kind)],
);

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    integrationId: text("integration_id").references(() => integrations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    event: text("event").notNull(),
    payload: text("payload").notNull().default(""),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("webhook_events_integration_idx").on(t.integrationId, t.receivedAt)],
);

export type Integration = typeof integrations.$inferSelect;
export type IntegrationLink = typeof integrationLinks.$inferSelect;
export type OAuthState = typeof oauthStates.$inferSelect;

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskLabel = typeof taskLabels.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type WikiVersion = typeof wikiVersions.$inferSelect;
export type Snippet = typeof snippets.$inferSelect;
export type SnippetTag = typeof snippetTags.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;
export type TaskAttachment = typeof taskAttachments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
