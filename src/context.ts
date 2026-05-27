import { AsyncLocalStorage } from "node:async_hooks";

export interface CfEnv {
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  AI_BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  SESSION_COOKIE_DOMAIN?: string;

  // Deployment URLs (used to build OAuth callbacks + post-OAuth redirects)
  APP_BASE_URL?: string; // e.g. https://api.devcollab.example.com (the worker)
  FRONTEND_BASE_URL?: string; // e.g. https://devcollab.example.com (the UI)

  // GitHub OAuth + webhook
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;

  // Slack OAuth (v2)
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;

  // Notion OAuth (public integration)
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
}

export interface RequestContext {
  env: CfEnv;
  request: Request;
  executionCtx: ExecutionContext;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "Request context unavailable. This function must run inside the Worker request handler.",
    );
  }
  return ctx;
}

export function getEnv(): CfEnv {
  return getRequestContext().env;
}
