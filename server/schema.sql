-- D1 SQLite schema for Obsidian Distributed Sync Worker
-- Provides monotonic changelog ordering, linear revision tracking with CAS, and device tokens.

CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  rev          INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  hash         TEXT,               -- SHA-256 hash; NULL indicates tombstone (deleted)
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,   -- Client timestamp (unix ms)
  deleted      INTEGER NOT NULL DEFAULT 0,
  folder       INTEGER NOT NULL DEFAULT 0,
  updated_by   TEXT,               -- Device identifier that made this change
  renamed_from TEXT                -- Source path if this is a rename operation
);

CREATE INDEX IF NOT EXISTS idx_files_seq ON files(seq);

CREATE TABLE IF NOT EXISTS revisions (
  path         TEXT NOT NULL,
  rev          INTEGER NOT NULL,
  hash         TEXT,
  mtime        INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  PRIMARY KEY (path, rev)
);

CREATE TABLE IF NOT EXISTS meta (
  key          TEXT PRIMARY KEY,
  value        TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hash         TEXT NOT NULL,      -- SHA-256 of the Bearer token
  created_at   INTEGER NOT NULL,
  last_used    INTEGER NOT NULL
);
