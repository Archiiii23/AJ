-- 0002_collab.sql
-- Adds: user profile columns, workspace tier, invites, snippet tags,
-- wiki versions, task attachments, notifications.

-- --- user profile additions ---
ALTER TABLE users ADD COLUMN avatar_url TEXT;
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';     -- JSON array
ALTER TABLE users ADD COLUMN github_url TEXT NOT NULL DEFAULT '';

-- --- workspaces billing tier ---
ALTER TABLE workspaces ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE workspaces ADD COLUMN tier_updated_at INTEGER NOT NULL DEFAULT 0;

-- --- workspace invites ---
CREATE TABLE workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL UNIQUE,
  invited_by_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX workspace_invites_workspace_idx ON workspace_invites(workspace_id);
CREATE INDEX workspace_invites_email_idx ON workspace_invites(email);

-- --- snippet tags ---
CREATE TABLE snippet_tags (
  id TEXT PRIMARY KEY,
  snippet_id TEXT NOT NULL REFERENCES snippets(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE INDEX snippet_tags_snippet_idx ON snippet_tags(snippet_id);
CREATE INDEX snippet_tags_name_idx ON snippet_tags(name);

-- --- wiki version history ---
CREATE TABLE wiki_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX wiki_versions_page_idx ON wiki_versions(page_id, created_at);

-- --- task attachments (URL based; storage out of scope) ---
CREATE TABLE task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT '',
  uploaded_by_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX task_attachments_task_idx ON task_attachments(task_id);

-- --- notifications (per-user inbox; distinct from activity feed) ---
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                                   -- 'mention' | 'assignment' | 'status_change' | 'invite' | 'comment'
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  read_at INTEGER,
  meta TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, read_at);
