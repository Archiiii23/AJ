# DevCollab Backend

Standalone Cloudflare Worker that hosts the DevCollab REST API on top of Cloudflare D1, Drizzle ORM, and Hono. Designed to be deployed separately from the frontend and consumed cross-origin with cookie-based sessions.

## Stack

- **Runtime**: Cloudflare Workers (`nodejs_compat` enabled)
- **Router**: Hono
- **Database**: Cloudflare D1 (SQLite-on-Workers)
- **ORM**: Drizzle ORM (`drizzle-orm/d1`)
- **Validation**: Zod
- **Auth**: PBKDF2 password hashing (Web Crypto) + HTTP-only session cookies stored in `sessions`
- **AI**: OpenAI-compatible Chat Completions when `OPENAI_API_KEY` is set, deterministic local fallback otherwise

## Local development

```bash
bun install
bun run db:migrate:local   # creates the local D1 file + applies schema
bun run dev                # wrangler dev on http://localhost:8787
```

Bootstrap the demo data on first start:

```bash
curl -X POST http://localhost:8787/auth/bootstrap
# -> seeds Acme Engineering workspace + demo@devcollab.app / devcollab123
```

## Deployment

```bash
# Create the production D1 (one-time)
bunx wrangler d1 create devcollab-db
# then update wrangler.jsonc with the returned database_id

# Apply schema to production D1
bun run db:migrate:remote

# Deploy the Worker
bun run deploy
```

After deploy, take the Worker URL (e.g. `https://devcollab-backend.<account>.workers.dev`) and set it as `VITE_API_URL` in the frontend.

## Environment

Configure via `wrangler.jsonc` `vars` (non-secret) and `wrangler secret put` (secrets):

| Name                    | Type           | Description                                                                                                                 |
| ----------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`       | var            | Comma-separated allow-list for CORS. Already includes localhost ports for dev. Add your frontend origin before going live.  |
| `SESSION_COOKIE_DOMAIN` | var (optional) | Set when frontend + backend share a parent domain (e.g. `.devcollab.app`) so the session cookie is visible to the frontend. |
| `OPENAI_API_KEY`        | secret         | Enables real LLM responses for `/ai/run`. Without it, deterministic mock output is returned.                                |
| `OPENAI_MODEL`          | var (optional) | Override the model (default `gpt-4o-mini`).                                                                                 |
| `AI_BASE_URL`           | var (optional) | Override the API base for OpenAI-compatible providers.                                                                      |

## Routes

| Path                           | Method         | Description                                                                                |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------ |
| `/health`                      | GET            | Liveness probe                                                                             |
| `/auth/bootstrap`              | POST           | Seeds the demo workspace + demo user (idempotent)                                          |
| `/auth/signup`                 | POST           | Create a new account                                                                       |
| `/auth/login`                  | POST           | Email + password login, sets `devcollab_session` cookie                                    |
| `/auth/logout`                 | POST           | Clears the session                                                                         |
| `/auth/me`                     | GET            | Returns the current user or `{ user: null }`                                               |
| `/workspaces`                  | GET            | Workspaces the user belongs to                                                             |
| `/workspace/summary`           | GET            | Dashboard summary (projects, tasks, progress)                                              |
| `/projects`                    | GET / POST     | List or create projects in the active workspace                                            |
| `/projects/:idOrSlug`          | GET            | Fetch a single project                                                                     |
| `/projects/:idOrSlug/tasks`    | GET / POST     | List or create tasks                                                                       |
| `/tasks/:id`                   | PATCH / DELETE | Update or delete a task                                                                    |
| `/tasks/bulk`                  | POST           | Bulk status/assignee update                                                                |
| `/tasks/bulk-delete`           | POST           | Bulk delete                                                                                |
| `/tasks/:id/comments`          | GET / POST     | Task comments                                                                              |
| `/projects/:idOrSlug/wiki`     | GET / POST     | List or create wiki pages                                                                  |
| `/wiki/:id`                    | PATCH / DELETE | Update or delete wiki pages                                                                |
| `/projects/:idOrSlug/snippets` | GET / POST     | List or create code snippets                                                               |
| `/snippets/:id`                | PATCH / DELETE | Update or delete snippets                                                                  |
| `/activity`                    | GET            | Workspace activity feed                                                                    |
| `/search?q=...`                | GET            | Cross-resource search                                                                      |
| `/ai/run`                      | POST           | Run an AI task (`summary`, `explain`, `standup`, `refactor`, `db`, `architecture`, `chat`) |
| `/ai/runs`                     | GET            | Recent AI runs for the user                                                                |

All routes except the `/health`, `/auth/*`, and `OPTIONS` preflights require a valid session cookie.

## Notes on cookies

- Same-site dev (`http://localhost:8082` ↔ `http://localhost:8787`): the browser treats different ports on the same hostname as same-site, so the cookie is sent on cross-origin requests with `SameSite=Lax`.
- Production cross-origin (e.g. `app.devcollab.app` ↔ `api.devcollab.app`): the auth module detects cross-origin requests and switches the cookie to `SameSite=None; Secure`. If you'd rather have one cookie that works on both subdomains, set `SESSION_COOKIE_DOMAIN=.devcollab.app`.
