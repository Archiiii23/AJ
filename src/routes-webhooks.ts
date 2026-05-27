import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { integrations, integrationLinks, webhookEvents } from "./schema";
import { prefixedId } from "./ids";
import { ingestGithubEvent } from "./routes-integrations";

const app = new Hono();

function ok<T>(data: T) {
  return Response.json({ data });
}
function fail(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

async function verifyGithubSignature(secret: string, sig: string, body: string): Promise<boolean> {
  if (!sig.startsWith("sha256=")) return false;
  const expected = sig.slice(7);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  const hex = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

app.post("/webhooks/github", async (c) => {
  const sig = c.req.header("x-hub-signature-256") ?? "";
  const event = c.req.header("x-github-event") ?? "";
  const delivery = c.req.header("x-github-delivery") ?? prefixedId("whg");
  const bodyText = await c.req.text();
  const body = (() => {
    try {
      return JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();
  const repo = (body.repository as { full_name?: string } | undefined)?.full_name ?? "";
  if (!repo) return fail(400, "no repo");

  const db = getDb();
  const matches = await db
    .select({ link: integrationLinks, it: integrations })
    .from(integrationLinks)
    .innerJoin(integrations, eq(integrationLinks.integrationId, integrations.id))
    .where(eq(integrationLinks.externalId, repo));
  if (matches.length === 0) return ok({ ignored: true });

  let verified: typeof matches | null = null;
  for (const m of matches) {
    if (await verifyGithubSignature(m.it.webhookSecret, sig, bodyText)) {
      verified = [m];
      break;
    }
  }
  if (!verified) return fail(401, "bad signature");

  const dupe = (
    await db.select().from(webhookEvents).where(eq(webhookEvents.id, delivery)).limit(1)
  )[0];
  if (dupe) return ok({ duplicate: true });

  await db.insert(webhookEvents).values({
    id: delivery,
    integrationId: verified[0].it.id,
    kind: "github",
    event,
    payload: bodyText.slice(0, 8000),
  });

  for (const m of verified) {
    await ingestGithubEvent(event, body, m.link.projectId, m.it.workspaceId);
  }
  return ok({ received: true });
});

// Health check (handy for uptime monitors)
app.get("/healthz", () => ok({ ok: true, ts: Date.now() }));

export default app;
