-- 0004: invite-only accounts.
--
-- Dashboard sign-in moves from "Sign in with Spotify, owner only" to email +
-- password accounts that only an admin can create (by emailed invite). The
-- Spotify grant in auth_tokens stays what it was: the collector's credentials,
-- now (re)connected from the app by an admin.
--
-- `auth_tokens` already holds the Spotify grant, so the single-use invite and
-- reset links live in `login_tokens`.
-- Timestamps are unix ms, like the rest of this database. Every token
-- (session, invite, reset) is stored only as its SHA-256 hex digest.

-- Sessions named a Spotify user id; they now name an account. Everyone signs in again.
DROP TABLE IF EXISTS sessions;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,                     -- crypto.randomUUID()
  email         TEXT NOT NULL UNIQUE,                 -- trimmed + lowercased
  name          TEXT,
  password_hash TEXT NOT NULL DEFAULT '',             -- '' = invited, not yet activated
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                      -- sha256(cookie value)
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,                        -- sha256(token); the token is only in the link
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,                        -- invite 7 days, reset 1 hour
  used_at    INTEGER
);
CREATE INDEX idx_login_tokens_user ON login_tokens (user_id);
