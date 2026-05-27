-- 0003_integrations.sql
-- Adds external integrations (GitHub, Slack, Notion), per-project links,
-- OAuth state cookies, and a webhook event log for idempotency.

-- One row per (workspace, kind). A workspace can connect at most one of each.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                             -- 'github' | 'slack' | 'notion'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',            -- gh login, slack team_id, notion workspace_id
  account_name TEXT NOT NULL DEFAULT '',          -- human-readable
  account_avatar TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',           -- slack incoming-webhook url, or empty
  webhook_secret TEXT NOT NULL DEFAULT '',        -- for outgoing GH webhook verification
  meta TEXT NOT NULL DEFAULT '{}',                -- JSON: extra fields per provider
  connected_by_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX integrations_workspace_kind_idx ON integrations(workspace_id, kind);

-- Links a project to a remote resource (a GH repo, a Slack channel, a Notion page).
CREATE TABLE integration_links (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,                      -- repo full_name / channel id / page id
  external_name TEXT NOT NULL DEFAULT '',
  external_url TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX integration_links_project_idx ON integration_links(project_id);
CREATE INDEX integration_links_integration_idx ON integration_links(integration_id);
CREATE UNIQUE INDEX integration_links_unique_idx
  ON integration_links(integration_id, project_id, external_id);

-- Short-lived OAuth state tokens (signed in cookie too, but we also persist for safety).
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX oauth_states_user_idx ON oauth_states(user_id, kind);

-- Idempotency log for inbound webhooks (GitHub).
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,                            -- provider delivery id
  integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX webhook_events_integration_idx ON webhook_events(integration_id, received_at);
