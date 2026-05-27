import api from "./api";
import { runWithContext, type CfEnv } from "./context";

function originsFor(env: CfEnv): string[] {
  const raw = env.ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request: Request, env: CfEnv): HeadersInit {
  const origin = request.headers.get("origin");
  const allowed = originsFor(env);
  const headers: Record<string, string> = {
    Vary: "Origin",
  };
  if (origin && (allowed.includes(origin) || allowed.includes("*"))) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS";
    headers["Access-Control-Allow-Headers"] =
      request.headers.get("access-control-request-headers") ?? "content-type, authorization";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function mergeHeaders(base: Response, extras: HeadersInit): Response {
  const headers = new Headers(base.headers);
  const more = new Headers(extras);
  more.forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(base.body, {
    status: base.status,
    statusText: base.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: CfEnv, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const response = await runWithContext({ env, request, executionCtx: ctx }, () =>
        api.fetch(request, env, ctx),
      );
      return mergeHeaders(response, cors);
    } catch (error) {
      console.error("Unhandled error:", error);
      return new Response(JSON.stringify({ error: { message: "Internal error" } }), {
        status: 500,
        headers: { "content-type": "application/json", ...cors },
      });
    }
  },
};
