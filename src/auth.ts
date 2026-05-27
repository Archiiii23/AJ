import { and, eq, gt } from "drizzle-orm";
import { getDb } from "./db";
import { sessions, users, type User } from "./schema";
import { nanoid, prefixedId } from "./ids";

const ENCODER = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000;
const SESSION_COOKIE = "devcollab_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function bytesToBase64(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str);
}

function base64ToBytes(b64: string): Uint8Array {
  const str = atob(b64);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function deriveHash(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, iterStr, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2") return false;
  const iter = Number.parseInt(iterStr, 10);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);
  const computed = await deriveHash(password, salt);
  if (computed.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) mismatch |= computed[i] ^ expected[i];
  return mismatch === 0;
}

export interface SessionEntry {
  id: string;
  userId: string;
}

export async function createSession(userId: string): Promise<SessionEntry> {
  const db = getDb();
  const id = `sess_${nanoid(24)}`;
  await db.insert(sessions).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { id, userId };
}

export async function deleteSession(id: string): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, id));
}

export async function getSessionUser(id: string | undefined): Promise<User | null> {
  if (!id) return null;
  const db = getDb();
  const rows = await db
    .select({
      user: users,
      sessionExpires: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!rows.length) return null;
  return rows[0].user;
}

export function readSessionCookie(req: Request): string | undefined {
  const cookie = req.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return v;
  }
  return undefined;
}

interface CookieEnvHints {
  domain?: string;
}

function buildCookie(
  value: string,
  maxAgeSec: number,
  request: Request,
  hints: CookieEnvHints = {},
): string {
  const url = new URL(request.url);
  const isHttps = url.protocol === "https:";
  const origin = request.headers.get("origin");
  const requestHost = url.hostname;
  // Cross-origin (different host) requests with credentials need SameSite=None + Secure.
  // Localhost dev (same hostname, different port) is "same-site", so Lax works.
  let crossOrigin = false;
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      crossOrigin = originHost !== requestHost;
    } catch {
      crossOrigin = false;
    }
  }
  const sameSite = crossOrigin ? "None" : "Lax";
  // SameSite=None requires Secure. On localhost we keep Lax so Secure is optional.
  const secure = isHttps || sameSite === "None";
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  if (hints.domain) parts.push(`Domain=${hints.domain}`);
  return parts.join("; ");
}

export function sessionCookie(
  value: string,
  request: Request,
  hints: CookieEnvHints = {},
  maxAgeSec = SESSION_TTL_MS / 1000,
): string {
  return buildCookie(value, maxAgeSec, request, hints);
}

export function expiredSessionCookie(request: Request, hints: CookieEnvHints = {}): string {
  return buildCookie("", 0, request, hints);
}

export const COLOR_POOL = [
  "oklch(0.7 0.15 155)",
  "oklch(0.65 0.14 240)",
  "oklch(0.78 0.14 80)",
  "oklch(0.6 0.18 27)",
  "oklch(0.6 0.1 200)",
  "oklch(0.65 0.16 320)",
  "oklch(0.62 0.14 110)",
];

export function pickColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLOR_POOL[h % COLOR_POOL.length];
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export const auth = {
  cookie: { name: SESSION_COOKIE, ttlMs: SESSION_TTL_MS },
  hash: hashPassword,
  verify: verifyPassword,
  createSession,
  deleteSession,
  getSessionUser,
  readSessionCookie,
  sessionCookie,
  expiredSessionCookie,
  newUserId: () => prefixedId("usr"),
};
