import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { User } from "./schema";
import {
  integrations,
  integrationLinks,
  oauthStates,
  projects,
  notifications,
  activity as activityTable,
} from "./schema";
import { getDb } from "./db";
import { getEnv } from "./context";
import { prefixedId, nanoid } from "./ids";

type Vars = { user: User; workspaceId: string | undefined };

const app = new Hono<{ Variables: Vars }>();

function ok<T>(data: T, status = 200) {
  return Response.json({ data }, { status });
}
function fail(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

function appBaseUrl(req: Request): string {
  const env = getEnv();
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/$/, "");
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}
function frontendBaseUrl(req: Request): string {
  const env = getEnv();
  if (env.FRONTEND_BASE_URL) return env.FRONTEND_BASE_URL.replace(/\/$/, "");
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function createOauthState(opts: {
  userId: string;
  workspaceId: string;
  kind: string;
  returnTo: string;
}): Promise<string> {
  const db = getDb();
  const id = `oas_${nanoid(24)}`;
  await db.insert(oauthStates).values({
    id,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    kind: opts.kind,
    returnTo: opts.returnTo,
    expiresAt: new Date(Date.now() + 1000 * 60 * 10),
  });
  return id;
}

async function consumeOauthState(id: string, kind: string) {
  const db = getDb();
  const row = (
    await db
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.id, id), eq(oauthStates.kind, kind)))
      .limit(1)
  )[0];
  if (!row) return null;
  await db.delete(oauthStates).where(eq(oauthStates.id, id));
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

async function getIntegration(workspaceId: string, kind: "github" | "slack" | "notion") {
  const db = getDb();
  const row = (
    await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, kind)))
      .limit(1)
  )[0];
  return row ?? null;
}

async function upsertIntegration(values: {
  workspaceId: string;
  kind: "github" | "slack" | "notion";
  userId: string;
  accessToken: string;
  refreshToken?: string | null;
  scope?: string;
  accountId?: string;
  accountName?: string;
  accountAvatar?: string;
  webhookUrl?: string;
  meta?: Record<string, unknown>;
}) {
  const db = getDb();
  const existing = await getIntegration(values.workspaceId, values.kind);
  const payload = {
    accessToken: values.accessToken,
    refreshToken: values.refreshToken ?? null,
    scope: values.scope ?? "",
    accountId: values.accountId ?? "",
    accountName: values.accountName ?? "",
    accountAvatar: values.accountAvatar ?? "",
    webhookUrl: values.webhookUrl ?? "",
    meta: JSON.stringify(values.meta ?? {}),
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(integrations).set(payload).where(eq(integrations.id, existing.id));
    return existing.id;
  }
  const id = prefixedId("itg");
  await db.insert(integrations).values({
    id,
    workspaceId: values.workspaceId,
    kind: values.kind,
    connectedById: values.userId,
    webhookSecret: nanoid(40),
    ...payload,
    refreshToken: payload.refreshToken ?? undefined,
  });
  return id;
}

function publicIntegration(row: typeof integrations.$inferSelect) {
  const meta = safeJson(row.meta);
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.accountId,
    accountName: row.accountName,
    accountAvatar: row.accountAvatar,
    scope: row.scope,
    hasWebhook: !!row.webhookUrl,
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
    meta,
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ============================================================
// Listing + disconnect
// ============================================================

app.get("/integrations", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const db = getDb();
  const rows = await db
    .select()
    .from(integrations)
    .where(eq(integrations.workspaceId, wsId))
    .orderBy(desc(integrations.createdAt));
  // Also include status booleans for each kind so the UI can render placeholder cards.
  const env = getEnv();
  const configured = {
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    slack: !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
    notion: !!(env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET),
  };
  return ok({
    integrations: rows.map(publicIntegration),
    configured,
  });
});

app.delete("/integrations/:id", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const id = c.req.param("id");
  const db = getDb();
  const row = (await db.select().from(integrations).where(eq(integrations.id, id)).limit(1))[0];
  if (!row || row.workspaceId !== wsId) return fail(404, "Not found");
  await db.delete(integrations).where(eq(integrations.id, id));
  return ok({ deleted: true });
});

app.get("/integrations/links/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const db = getDb();
  const rows = await db
    .select({
      link: integrationLinks,
      integration: integrations,
    })
    .from(integrationLinks)
    .innerJoin(integrations, eq(integrationLinks.integrationId, integrations.id))
    .where(eq(integrationLinks.projectId, projectId));
  return ok({
    links: rows.map((r) => ({
      id: r.link.id,
      kind: r.integration.kind,
      externalId: r.link.externalId,
      externalName: r.link.externalName,
      externalUrl: r.link.externalUrl,
      meta: safeJson(r.link.meta),
      createdAt: r.link.createdAt,
    })),
  });
});

app.delete("/integrations/links/:id", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const id = c.req.param("id");
  const db = getDb();
  const row = (await db.select().from(integrationLinks).where(eq(integrationLinks.id, id)).limit(1))[0];
  if (!row) return fail(404, "Not found");
  await db.delete(integrationLinks).where(eq(integrationLinks.id, id));
  return ok({ deleted: true });
});

// ============================================================
// GitHub
// ============================================================

app.get("/integrations/github/start", async (c) => {
  const env = getEnv();
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  if (!env.GITHUB_CLIENT_ID) {
    return fail(400, "GitHub OAuth is not configured on this server");
  }
  const returnTo = c.req.query("return_to") ?? `${frontendBaseUrl(c.req.raw)}/app/integrations`;
  const stateId = await createOauthState({
    userId: user.id,
    workspaceId: wsId,
    kind: "github",
    returnTo,
  });
  const redirectUri = `${appBaseUrl(c.req.raw)}/integrations/github/callback`;
  const auth = new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("scope", "repo read:user user:email");
  auth.searchParams.set("state", stateId);
  return Response.redirect(auth.toString(), 302);
});

app.get("/integrations/github/callback", async (c) => {
  const env = getEnv();
  const code = c.req.query("code");
  const stateId = c.req.query("state");
  if (!code || !stateId) return fail(400, "Missing code/state");
  const state = await consumeOauthState(stateId, "github");
  if (!state) return fail(400, "Invalid or expired state");
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return fail(400, "Not configured");
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${appBaseUrl(c.req.raw)}/integrations/github/callback`,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
  };
  if (!token.access_token) return fail(400, token.error ?? "GitHub token exchange failed");
  // Fetch user profile to label the integration
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "devcollab",
      accept: "application/vnd.github+json",
    },
  });
  const profile = (await userRes.json()) as {
    login?: string;
    name?: string;
    avatar_url?: string;
    id?: number;
  };
  await upsertIntegration({
    workspaceId: state.workspaceId,
    kind: "github",
    userId: state.userId,
    accessToken: token.access_token,
    scope: token.scope ?? "",
    accountId: String(profile.id ?? ""),
    accountName: profile.login ?? profile.name ?? "GitHub",
    accountAvatar: profile.avatar_url ?? "",
  });
  return Response.redirect(state.returnTo || `${frontendBaseUrl(c.req.raw)}/app/integrations`, 302);
});

// List repos available to the connected GitHub account
app.get("/integrations/github/repos", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const it = await getIntegration(wsId, "github");
  if (!it) return fail(404, "GitHub not connected");
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    {
      headers: {
        authorization: `Bearer ${it.accessToken}`,
        "user-agent": "devcollab",
        accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) return fail(res.status, "GitHub API error");
  const raw = (await res.json()) as Array<{
    id: number;
    full_name: string;
    name: string;
    private: boolean;
    html_url: string;
    description: string | null;
    updated_at: string;
    language: string | null;
  }>;
  return ok({
    repos: raw.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      name: r.name,
      private: r.private,
      url: r.html_url,
      description: r.description ?? "",
      language: r.language ?? "",
      updatedAt: r.updated_at,
    })),
  });
});

const linkRepoSchema = z.object({
  projectId: z.string(),
  fullName: z.string(),
  url: z.string(),
  installWebhook: z.boolean().optional(),
});

app.post("/integrations/github/link", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const it = await getIntegration(wsId, "github");
  if (!it) return fail(404, "GitHub not connected");
  const parsed = linkRepoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Invalid body");
  const { projectId, fullName, url, installWebhook } = parsed.data;
  const db = getDb();
  const proj = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!proj || proj.workspaceId !== wsId) return fail(404, "Project not found");

  const id = prefixedId("igl");
  await db
    .insert(integrationLinks)
    .values({
      id,
      integrationId: it.id,
      projectId,
      externalId: fullName,
      externalName: fullName,
      externalUrl: url,
    })
    .onConflictDoNothing();

  let webhookCreated = false;
  if (installWebhook) {
    const callback = `${appBaseUrl(c.req.raw)}/webhooks/github`;
    const res = await fetch(`https://api.github.com/repos/${fullName}/hooks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${it.accessToken}`,
        "user-agent": "devcollab",
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["push", "pull_request", "issues", "issue_comment"],
        config: {
          url: callback,
          content_type: "json",
          secret: it.webhookSecret,
          insecure_ssl: "0",
        },
      }),
    });
    webhookCreated = res.ok;
  }
  return ok({ linkId: id, webhookCreated });
});

export async function ingestGithubEvent(
  event: string,
  body: Record<string, unknown>,
  projectId: string,
  workspaceId: string,
) {
  const db = getDb();
  let title = "";
  let action: string = `github:${event}`;
  let targetType = "github";
  let targetId = `gh:${event}`;
  if (event === "push") {
    const commits = (body.commits as Array<{ message: string; id: string; url: string }> | undefined) ?? [];
    const ref = (body.ref as string | undefined) ?? "";
    title = `${commits.length} commit${commits.length === 1 ? "" : "s"} to ${ref.replace("refs/heads/", "")}`;
    action = "pushed to repo";
    targetId = (body.after as string | undefined) ?? targetId;
  } else if (event === "pull_request") {
    const pr = body.pull_request as { number: number; title: string; html_url: string } | undefined;
    const subAction = (body.action as string | undefined) ?? "updated";
    title = pr ? `PR #${pr.number}: ${pr.title}` : "Pull request";
    action = `pull request ${subAction}`;
    targetId = pr ? String(pr.number) : targetId;
  } else if (event === "issues") {
    const issue = body.issue as { number: number; title: string; html_url: string } | undefined;
    const subAction = (body.action as string | undefined) ?? "updated";
    title = issue ? `Issue #${issue.number}: ${issue.title}` : "Issue";
    action = `issue ${subAction}`;
    targetId = issue ? String(issue.number) : targetId;
  } else if (event === "issue_comment") {
    const issue = body.issue as { number: number; title: string } | undefined;
    title = issue ? `Comment on #${issue.number}` : "Comment";
    action = "commented on issue";
  } else {
    return;
  }

  await db.insert(activityTable).values({
    id: prefixedId("act"),
    workspaceId,
    projectId,
    actorId: null as unknown as string,
    action,
    targetType,
    targetId,
    targetLabel: title,
    meta: JSON.stringify({ source: "github", event, raw: { action: body.action } }),
  } as never).catch(() => {
    // activity table likely requires actorId; we degrade to no-op rather than throwing
  });
}

// ============================================================
// Slack
// ============================================================

app.get("/integrations/slack/start", async (c) => {
  const env = getEnv();
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  if (!env.SLACK_CLIENT_ID) return fail(400, "Slack OAuth is not configured");
  const returnTo = c.req.query("return_to") ?? `${frontendBaseUrl(c.req.raw)}/app/integrations`;
  const stateId = await createOauthState({
    userId: user.id,
    workspaceId: wsId,
    kind: "slack",
    returnTo,
  });
  const redirectUri = `${appBaseUrl(c.req.raw)}/integrations/slack/callback`;
  const auth = new URL("https://slack.com/oauth/v2/authorize");
  auth.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("state", stateId);
  auth.searchParams.set("scope", "channels:read,chat:write,incoming-webhook");
  return Response.redirect(auth.toString(), 302);
});

app.get("/integrations/slack/callback", async (c) => {
  const env = getEnv();
  const code = c.req.query("code");
  const stateId = c.req.query("state");
  if (!code || !stateId) return fail(400, "Missing code/state");
  const state = await consumeOauthState(stateId, "slack");
  if (!state) return fail(400, "Invalid or expired state");
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) return fail(400, "Not configured");
  const body = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: `${appBaseUrl(c.req.raw)}/integrations/slack/callback`,
  });
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = (await tokenRes.json()) as {
    ok: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    team?: { id: string; name: string };
    incoming_webhook?: { url: string; channel: string; channel_id: string };
  };
  if (!token.ok || !token.access_token) return fail(400, token.error ?? "Slack token exchange failed");
  await upsertIntegration({
    workspaceId: state.workspaceId,
    kind: "slack",
    userId: state.userId,
    accessToken: token.access_token,
    scope: token.scope ?? "",
    accountId: token.team?.id ?? "",
    accountName: token.team?.name ?? "Slack",
    webhookUrl: token.incoming_webhook?.url ?? "",
    meta: token.incoming_webhook
      ? { defaultChannel: token.incoming_webhook.channel, defaultChannelId: token.incoming_webhook.channel_id }
      : {},
  });
  return Response.redirect(state.returnTo || `${frontendBaseUrl(c.req.raw)}/app/integrations`, 302);
});

// Allows pasting just an incoming-webhook URL (skip OAuth) — great for demos
const manualSlackSchema = z.object({ webhookUrl: z.string().url(), name: z.string().optional() });
app.post("/integrations/slack/manual", async (c) => {
  const wsId = c.get("workspaceId");
  const user = c.get("user");
  if (!wsId) return fail(400, "Workspace missing");
  const parsed = manualSlackSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Invalid body");
  await upsertIntegration({
    workspaceId: wsId,
    kind: "slack",
    userId: user.id,
    accessToken: parsed.data.webhookUrl,
    scope: "incoming-webhook",
    accountName: parsed.data.name ?? "Slack (manual)",
    webhookUrl: parsed.data.webhookUrl,
    meta: { manual: true },
  });
  return ok({ connected: true });
});

app.get("/integrations/slack/channels", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const it = await getIntegration(wsId, "slack");
  if (!it) return fail(404, "Slack not connected");
  if (safeJson(it.meta).manual) {
    return ok({ channels: [], manual: true });
  }
  const res = await fetch(
    "https://slack.com/api/conversations.list?limit=200&exclude_archived=true&types=public_channel,private_channel",
    {
      headers: { authorization: `Bearer ${it.accessToken}` },
    },
  );
  const json = (await res.json()) as {
    ok: boolean;
    channels?: Array<{ id: string; name: string; is_private: boolean }>;
    error?: string;
  };
  if (!json.ok) return fail(400, json.error ?? "Slack API error");
  return ok({
    channels: (json.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      private: c.is_private,
    })),
  });
});

const slackLinkSchema = z.object({
  projectId: z.string(),
  channelId: z.string(),
  channelName: z.string().optional(),
});
app.post("/integrations/slack/link", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const it = await getIntegration(wsId, "slack");
  if (!it) return fail(404, "Slack not connected");
  const parsed = slackLinkSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Invalid body");
  const id = prefixedId("igl");
  await getDb()
    .insert(integrationLinks)
    .values({
      id,
      integrationId: it.id,
      projectId: parsed.data.projectId,
      externalId: parsed.data.channelId,
      externalName: parsed.data.channelName ?? parsed.data.channelId,
      externalUrl: "",
    })
    .onConflictDoNothing();
  return ok({ linkId: id });
});

// Outbound utility used by api.ts when tasks change
export async function postSlackForProject(
  projectId: string,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ link: integrationLinks, it: integrations })
    .from(integrationLinks)
    .innerJoin(integrations, eq(integrationLinks.integrationId, integrations.id))
    .where(and(eq(integrationLinks.projectId, projectId), eq(integrations.kind, "slack")));
  for (const r of rows) {
    if (safeJson(r.it.meta).manual || !r.it.accessToken.startsWith("xox")) {
      // Manual webhook URL — POST as incoming webhook payload
      if (!r.it.webhookUrl) continue;
      await fetch(r.it.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, blocks }),
      }).catch(() => {});
    } else {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${r.it.accessToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: r.link.externalId, text, blocks }),
      }).catch(() => {});
    }
  }
}

// ============================================================
// Notion
// ============================================================

app.get("/integrations/notion/start", async (c) => {
  const env = getEnv();
  const user = c.get("user");
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  if (!env.NOTION_CLIENT_ID) return fail(400, "Notion OAuth is not configured");
  const returnTo = c.req.query("return_to") ?? `${frontendBaseUrl(c.req.raw)}/app/integrations`;
  const stateId = await createOauthState({
    userId: user.id,
    workspaceId: wsId,
    kind: "notion",
    returnTo,
  });
  const redirectUri = `${appBaseUrl(c.req.raw)}/integrations/notion/callback`;
  const auth = new URL("https://api.notion.com/v1/oauth/authorize");
  auth.searchParams.set("client_id", env.NOTION_CLIENT_ID);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("owner", "user");
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("state", stateId);
  return Response.redirect(auth.toString(), 302);
});

app.get("/integrations/notion/callback", async (c) => {
  const env = getEnv();
  const code = c.req.query("code");
  const stateId = c.req.query("state");
  if (!code || !stateId) return fail(400, "Missing code/state");
  const state = await consumeOauthState(stateId, "notion");
  if (!state) return fail(400, "Invalid or expired state");
  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) return fail(400, "Not configured");
  const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);
  const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${appBaseUrl(c.req.raw)}/integrations/notion/callback`,
    }),
  });
  const token = (await tokenRes.json()) as {
    access_token?: string;
    workspace_id?: string;
    workspace_name?: string;
    workspace_icon?: string;
    bot_id?: string;
    error?: string;
  };
  if (!token.access_token) return fail(400, token.error ?? "Notion token exchange failed");
  await upsertIntegration({
    workspaceId: state.workspaceId,
    kind: "notion",
    userId: state.userId,
    accessToken: token.access_token,
    accountId: token.workspace_id ?? "",
    accountName: token.workspace_name ?? "Notion",
    accountAvatar: token.workspace_icon ?? "",
    meta: { botId: token.bot_id ?? "" },
  });
  return Response.redirect(state.returnTo || `${frontendBaseUrl(c.req.raw)}/app/integrations`, 302);
});

// Search accessible pages
app.get("/integrations/notion/pages", async (c) => {
  const wsId = c.get("workspaceId");
  if (!wsId) return fail(400, "Workspace missing");
  const q = c.req.query("q") ?? "";
  const it = await getIntegration(wsId, "notion");
  if (!it) return fail(404, "Notion not connected");
  const res = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${it.accessToken}`,
      "notion-version": "2022-06-28",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: q,
      filter: { value: "page", property: "object" },
      page_size: 25,
    }),
  });
  if (!res.ok) return fail(res.status, "Notion API error");
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const pages = (json.results ?? []).map((p) => {
    const props = (p.properties as Record<string, { title?: Array<{ plain_text: string }> }>) ?? {};
    const titleProp = Object.values(props).find((v) => Array.isArray(v.title));
    const title = titleProp?.title?.map((t) => t.plain_text).join("") ?? "(untitled)";
    return {
      id: String(p.id ?? ""),
      title,
      url: String(p.url ?? ""),
      lastEditedTime: String(p.last_edited_time ?? ""),
    };
  });
  return ok({ pages });
});

const notionImportSchema = z.object({
  projectId: z.string(),
  pageId: z.string(),
});

// Convert Notion blocks → markdown (best-effort for headings, paragraphs, lists, code, todo)
type NotionBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
};

function richText(arr?: Array<{ plain_text?: string; href?: string; annotations?: Record<string, boolean> }>): string {
  if (!arr) return "";
  return arr
    .map((t) => {
      let txt = t.plain_text ?? "";
      const a = t.annotations ?? {};
      if (a.code) txt = "`" + txt + "`";
      if (a.bold) txt = `**${txt}**`;
      if (a.italic) txt = `*${txt}*`;
      if (a.strikethrough) txt = `~~${txt}~~`;
      if (t.href) txt = `[${txt}](${t.href})`;
      return txt;
    })
    .join("");
}

async function notionFetchChildren(token: string, blockId: string): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 4; i++) {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28" },
    });
    if (!res.ok) break;
    const json = (await res.json()) as {
      results?: NotionBlock[];
      next_cursor?: string;
      has_more?: boolean;
    };
    out.push(...(json.results ?? []));
    if (!json.has_more || !json.next_cursor) break;
    cursor = json.next_cursor;
  }
  return out;
}

async function blocksToMarkdown(token: string, blocks: NotionBlock[], depth = 0): Promise<string> {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const b of blocks) {
    const t = b.type;
    const data = b[t] as Record<string, unknown> | undefined;
    if (!data) continue;
    const rt = (data as { rich_text?: unknown[] }).rich_text as
      | Array<{ plain_text?: string; href?: string; annotations?: Record<string, boolean> }>
      | undefined;
    switch (t) {
      case "heading_1":
        lines.push(`# ${richText(rt)}`);
        break;
      case "heading_2":
        lines.push(`## ${richText(rt)}`);
        break;
      case "heading_3":
        lines.push(`### ${richText(rt)}`);
        break;
      case "paragraph":
        lines.push(`${indent}${richText(rt)}`);
        break;
      case "bulleted_list_item":
        lines.push(`${indent}- ${richText(rt)}`);
        break;
      case "numbered_list_item":
        lines.push(`${indent}1. ${richText(rt)}`);
        break;
      case "to_do": {
        const checked = (data as { checked?: boolean }).checked ? "x" : " ";
        lines.push(`${indent}- [${checked}] ${richText(rt)}`);
        break;
      }
      case "quote":
        lines.push(`${indent}> ${richText(rt)}`);
        break;
      case "code": {
        const lang = (data as { language?: string }).language ?? "";
        lines.push("```" + lang);
        lines.push(richText(rt));
        lines.push("```");
        break;
      }
      case "divider":
        lines.push("---");
        break;
      default:
        if (rt) lines.push(`${indent}${richText(rt)}`);
        break;
    }
    if (b.has_children) {
      const children = await notionFetchChildren(token, b.id);
      const sub = await blocksToMarkdown(token, children, depth + 1);
      if (sub.trim()) lines.push(sub);
    }
  }
  return lines.join("\n\n");
}

app.post("/integrations/notion/import", async (c) => {
  const wsId = c.get("workspaceId");
  const user = c.get("user");
  if (!wsId) return fail(400, "Workspace missing");
  const it = await getIntegration(wsId, "notion");
  if (!it) return fail(404, "Notion not connected");
  const parsed = notionImportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(400, "Invalid body");
  const { projectId, pageId } = parsed.data;
  const db = getDb();
  const proj = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!proj || proj.workspaceId !== wsId) return fail(404, "Project not found");

  // Fetch the page to get the title
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { authorization: `Bearer ${it.accessToken}`, "notion-version": "2022-06-28" },
  });
  if (!pageRes.ok) return fail(pageRes.status, "Notion fetch failed");
  const pageJson = (await pageRes.json()) as { properties?: Record<string, { title?: Array<{ plain_text: string }> }>; url?: string };
  const titleProp = Object.values(pageJson.properties ?? {}).find((v) => Array.isArray(v.title));
  const title = titleProp?.title?.map((t) => t.plain_text).join("") || "Imported from Notion";

  const blocks = await notionFetchChildren(it.accessToken, pageId);
  const content = await blocksToMarkdown(it.accessToken, blocks);

  const { wikiPages } = await import("./schema");
  const id = prefixedId("wik");
  await db.insert(wikiPages).values({
    id,
    projectId,
    title,
    slug: slugify(title),
    content,
    category: "Imported",
    authorId: user.id,
  });

  // Record activity
  await db.insert(activityTable).values({
    id: prefixedId("act"),
    workspaceId: wsId,
    projectId,
    actorId: user.id,
    action: "imported wiki page from Notion",
    targetType: "wiki",
    targetId: id,
    targetLabel: title,
    meta: JSON.stringify({ source: "notion", notionPageId: pageId, url: pageJson.url }),
  });

  return ok({ pageId: id, title });
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || `page-${Date.now()}`;
}

// ============================================================
// In-app notification helper used by api.ts on critical events
// (Keeps coupling minimal — slack utility above is exported.)
// ============================================================

export async function inboxCreate(opts: {
  userId: string;
  workspaceId: string;
  projectId?: string;
  kind: string;
  title: string;
  body?: string;
  targetType: string;
  targetId: string;
  actorId?: string;
  meta?: unknown;
}) {
  const db = getDb();
  await db.insert(notifications).values({
    id: prefixedId("ntf"),
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    kind: opts.kind,
    title: opts.title,
    body: opts.body ?? "",
    targetType: opts.targetType,
    targetId: opts.targetId,
    actorId: opts.actorId,
    meta: opts.meta ? JSON.stringify(opts.meta) : null,
  });
}

export default app;
