// D1 Database access layer for file records, sequence ordering, and atomic CAS revisions.

export interface FileRecord {
  path: string;
  rev: number;
  seq: number;
  hash: string | null;
  size: number;
  mtime: number;
  deleted: number;
  folder: number;
  updated_by: string | null;
  renamed_from: string | null;
}

export interface DeletedFileEntry {
  path: string;
  rev: number;
  deleted_at: number;
  content_rev: number;
  hash: string;
}

export class ConflictError extends Error {
  readonly path: string;
  readonly serverRev: number;
  readonly serverHash: string | null;
  readonly deleted: boolean;
  readonly updatedBy: string | null;

  constructor(
    path: string,
    serverRev: number,
    serverHash: string | null,
    deleted: boolean,
    updatedBy: string | null
  ) {
    super(`Conflict on ${path}: server rev is ${serverRev}`);
    this.name = "ConflictError";
    this.path = path;
    this.serverRev = serverRev;
    this.serverHash = serverHash;
    this.deleted = deleted;
    this.updatedBy = updatedBy;
  }
}

export async function getFile(db: D1Database, path: string): Promise<FileRecord | null> {
  const row = await db
    .prepare(
      "SELECT path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from FROM files WHERE path = ?"
    )
    .bind(path)
    .first<FileRecord>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Atomic metadata publication
//
// D1 has no interactive transactions, but a single `db.batch()` is executed as
// one implicit transaction. Every mutation below therefore:
//   1. advances the monotonic seq counter *inside* the batch, so the seq a
//      change is published with cannot be allocated by anyone else;
//   2. performs the files-row change as a conditional INSERT ... SELECT ...
//      ON CONFLICT DO UPDATE ... RETURNING whose WHERE clause re-checks the
//      base revision at write time (the advisory getFile() checks are only
//      there for fast/typed errors);
//   3. writes the matching revisions row with a second conditional INSERT
//      guarded by the seq just published, so an old/competing attempt can
//      never create a revision for a state it did not publish.
// A guard that matches no row is a conflict; nothing is written for that path.
// The seq counter may still advance on a failed attempt (a harmless gap).
// ---------------------------------------------------------------------------

type FilesRow = {
  path: string;
  rev: number;
  seq: number;
  hash: string | null;
  size: number;
  mtime: number;
  deleted: number;
  folder: number;
  updated_by: string | null;
  renamed_from: string | null;
};

const FILES_COLUMNS =
  "path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from";
const FILES_RETURNING = `RETURNING ${FILES_COLUMNS}`;

// Allocate and read the next sequence value within the current batch. The
// seed statement makes the counter survive a database whose files rows predate
// (or lost) the meta row, then the bump is atomic with the metadata write.
const SEQ_SEED_SQL = `INSERT OR IGNORE INTO meta (key, value)
SELECT 'seq', CAST(COALESCE(MAX(seq), 0) AS TEXT) FROM files`;
const SEQ_BUMP_SQL = `UPDATE meta
SET value = CAST(MAX(
  COALESCE(CAST(value AS INTEGER), 0),
  COALESCE((SELECT MAX(seq) FROM files), 0)
) + 1 AS TEXT)
WHERE key = 'seq'`;
const SEQ_NOW = `CAST((SELECT value FROM meta WHERE key = 'seq') AS INTEGER)`;
// Used by rename: after two advances, the destination was published at prev.
const SEQ_PREVIOUS = `CAST(CAST((SELECT value FROM meta WHERE key = 'seq') AS INTEGER) - 1 AS INTEGER)`;

// A write (or resurrecting write) is allowed when the row is still at baseRev,
// or when it does not exist and the client is creating from scratch (base 0).
const BASE_REV_GUARD = `EXISTS (SELECT 1 FROM files WHERE path = ? AND rev = ?)
   OR (? = 0 AND NOT EXISTS (SELECT 1 FROM files WHERE path = ?))`;

const WRITE_FILE_SQL = `INSERT INTO files (${FILES_COLUMNS})
SELECT ?, ?, ${SEQ_NOW}, ?, ?, ?, 0, ?, ?, NULL
WHERE ${BASE_REV_GUARD}
ON CONFLICT(path) DO UPDATE SET
  rev = excluded.rev,
  seq = excluded.seq,
  hash = excluded.hash,
  size = excluded.size,
  mtime = excluded.mtime,
  deleted = excluded.deleted,
  folder = excluded.folder,
  updated_by = excluded.updated_by,
  renamed_from = COALESCE(excluded.renamed_from, files.renamed_from)
${FILES_RETURNING}`;

const DELETE_FILE_SQL = `INSERT INTO files (${FILES_COLUMNS})
SELECT ?, ?, ${SEQ_NOW}, NULL, 0, ?, 1, ?, ?, NULL
WHERE ${BASE_REV_GUARD}
ON CONFLICT(path) DO UPDATE SET
  rev = excluded.rev,
  seq = excluded.seq,
  hash = excluded.hash,
  size = excluded.size,
  mtime = excluded.mtime,
  deleted = excluded.deleted,
  folder = excluded.folder,
  updated_by = excluded.updated_by,
  renamed_from = excluded.renamed_from
${FILES_RETURNING}`;

// The revision row is derived from the files row that this same batch just
// published, so it can never describe a state owned by another writer.
const REVISION_INSERT_SQL = `INSERT INTO revisions (path, rev, hash, mtime, seq)
SELECT path, rev, hash, mtime, seq FROM files
WHERE path = ? AND rev = ? AND seq = ${SEQ_NOW}
ON CONFLICT(path, rev) DO NOTHING`;

const RENAME_DST_SQL = `INSERT INTO files (${FILES_COLUMNS})
SELECT ?, ?, ${SEQ_NOW}, ?, ?, ?, 0, ?, ?, ?
WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND rev = ? AND deleted = 0)
  AND (
    (? = 0 AND NOT EXISTS (SELECT 1 FROM files WHERE path = ?))
    OR EXISTS (SELECT 1 FROM files WHERE path = ? AND rev = ? AND deleted = 1)
  )
ON CONFLICT(path) DO UPDATE SET
  rev = excluded.rev,
  seq = excluded.seq,
  hash = excluded.hash,
  size = excluded.size,
  mtime = excluded.mtime,
  deleted = excluded.deleted,
  folder = excluded.folder,
  updated_by = excluded.updated_by,
  renamed_from = excluded.renamed_from
${FILES_RETURNING}`;

// The source tombstone additionally requires the destination row published by
// this batch (seq = previous counter value). If the destination precondition
// failed, this statement is a no-op too, so a failed rename cannot leave a
// half-applied tombstone behind.
const RENAME_SRC_SQL = `INSERT INTO files (${FILES_COLUMNS})
SELECT ?, ?, ${SEQ_NOW}, NULL, 0, ?, 1, ?, ?, NULL
WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND rev = ? AND deleted = 0)
  AND EXISTS (
    SELECT 1 FROM files
    WHERE path = ? AND rev = ? AND seq = ${SEQ_PREVIOUS} AND deleted = 0
  )
ON CONFLICT(path) DO UPDATE SET
  rev = excluded.rev,
  seq = excluded.seq,
  hash = excluded.hash,
  size = excluded.size,
  mtime = excluded.mtime,
  deleted = excluded.deleted,
  folder = excluded.folder,
  updated_by = excluded.updated_by,
  renamed_from = excluded.renamed_from
${FILES_RETURNING}`;

function toRecord(row: FilesRow): FileRecord {
  return {
    path: row.path,
    rev: row.rev,
    seq: row.seq,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    deleted: row.deleted,
    folder: row.folder,
    updated_by: row.updated_by,
    renamed_from: row.renamed_from,
  };
}

function batchRow(results: D1Result[] | undefined, index: number): FilesRow | null {
  const rows = results?.[index]?.results as FilesRow[] | undefined;
  return rows && rows.length > 0 ? rows[0] : null;
}

// Seed (if needed) and advance the monotonic seq counter inside a batch.
function seqAdvance(db: D1Database): D1PreparedStatement[] {
  return [db.prepare(SEQ_SEED_SQL), db.prepare(SEQ_BUMP_SQL)];
}


export async function getRevisionHash(
  db: D1Database,
  path: string,
  rev: number
): Promise<string | null> {
  const row = await db
    .prepare("SELECT hash FROM revisions WHERE path = ? AND rev = ?")
    .bind(path, rev)
    .first<{ hash: string | null }>();
  return row?.hash ?? null;
}

export async function getNextSeq(db: D1Database): Promise<number> {
  // Use meta key='seq' to maintain monotonic counter
  const res = await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('seq', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
       RETURNING CAST(value AS INTEGER) as seq`
    )
    .first<{ seq: number }>();
  if (res && typeof res.seq === "number") {
    return res.seq;
  }

  // Fallback: get current max seq + 1
  const maxRow = await db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM files").first<{ next_seq: number }>();
  const next = maxRow?.next_seq ?? 1;
  await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)").bind(String(next)).run();
  return next;
}

export async function getCurrentSeq(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT CAST(value AS INTEGER) as seq FROM meta WHERE key = 'seq'").first<{ seq: number }>();
  if (row?.seq != null) return row.seq;
  const maxRow = await db.prepare("SELECT COALESCE(MAX(seq), 0) as max_seq FROM files").first<{ max_seq: number }>();
  return maxRow?.max_seq ?? 0;
}

export async function getChanges(
  db: D1Database,
  since: number,
  limit: number = 500
): Promise<{ entries: FileRecord[]; next_seq: number; has_more: boolean }> {
  const safeLimit = Math.min(Math.max(limit, 1), 1000);
  const rows = await db
    .prepare(
      `SELECT path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from
       FROM files
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(since, safeLimit + 1)
    .all<FileRecord>();

  const all = rows.results || [];
  const has_more = all.length > safeLimit;
  const entries = has_more ? all.slice(0, safeLimit) : all;
  const next_seq = entries.length > 0 ? entries[entries.length - 1].seq : since;

  return { entries, next_seq, has_more };
}

export async function writeFile(
  db: D1Database,
  file: {
    path: string;
    baseRev: number;
    hash: string;
    size: number;
    mtime: number;
    folder: boolean;
    updatedBy: string;
  }
): Promise<{ record: FileRecord; isNoop: boolean }> {
  const cur = await getFile(db, file.path);

  // Idempotency check: if identical content already written and not deleted, no-op!
  // This is a read-only fast path; it never publishes new metadata.
  if (cur && cur.deleted === 0 && cur.hash === file.hash && cur.folder === (file.folder ? 1 : 0)) {
    return { record: cur, isNoop: true };
  }

  // Advisory compare-and-swap check for a fast, typed error. The authority is
  // the conditional SQL below, which re-checks the same base revision inside
  // the batch transaction.
  const currentRev = cur ? cur.rev : 0;
  if (currentRev !== file.baseRev) {
    throw new ConflictError(
      file.path,
      cur ? cur.rev : 0,
      cur ? cur.hash : null,
      cur ? Boolean(cur.deleted) : false,
      cur ? cur.updated_by : null
    );
  }

  const nextRev = currentRev + 1;
  const hash = file.folder ? null : file.hash;

  const results = await db.batch([
    ...seqAdvance(db),
    db
      .prepare(WRITE_FILE_SQL)
      .bind(
        file.path,
        nextRev,
        hash,
        file.size,
        file.mtime,
        file.folder ? 1 : 0,
        file.updatedBy,
        file.path,
        file.baseRev,
        file.baseRev,
        file.path
      ),
    db.prepare(REVISION_INSERT_SQL).bind(file.path, nextRev),
  ]);

  const published = batchRow(results, 2);
  if (!published) {
    // The row moved between the advisory read and the batch. Report the state
    // that actually rejected the write.
    const actual = await getFile(db, file.path);
    throw new ConflictError(
      file.path,
      actual ? actual.rev : 0,
      actual ? actual.hash : null,
      actual ? Boolean(actual.deleted) : false,
      actual ? actual.updated_by : null
    );
  }

  return { record: toRecord(published), isNoop: false };
}

export async function deleteFile(
  db: D1Database,
  path: string,
  baseRev: number,
  updatedBy: string
): Promise<FileRecord> {
  const cur = await getFile(db, path);
  if (!cur || cur.deleted === 1) {
    // If already deleted and baseRev matches current rev, return current
    if (cur && cur.rev === baseRev) {
      return cur;
    }
  }

  // Advisory check; the conditional SQL inside the batch is authoritative.
  const currentRev = cur ? cur.rev : 0;
  if (currentRev !== baseRev) {
    throw new ConflictError(
      path,
      cur ? cur.rev : 0,
      cur ? cur.hash : null,
      cur ? Boolean(cur.deleted) : true,
      cur ? cur.updated_by : null
    );
  }

  const nextRev = currentRev + 1;
  const folder = cur ? cur.folder : 0;
  const mtime = Date.now();

  const results = await db.batch([
    ...seqAdvance(db),
    db
      .prepare(DELETE_FILE_SQL)
      .bind(path, nextRev, mtime, folder, updatedBy, path, baseRev, baseRev, path),
    db.prepare(REVISION_INSERT_SQL).bind(path, nextRev),
  ]);

  const published = batchRow(results, 2);
  if (!published) {
    const actual = await getFile(db, path);
    throw new ConflictError(
      path,
      actual ? actual.rev : 0,
      actual ? actual.hash : null,
      actual ? Boolean(actual.deleted) : true,
      actual ? actual.updated_by : null
    );
  }

  return toRecord(published);
}

export async function renameFile(
  db: D1Database,
  from: string,
  to: string,
  baseRev: number,
  updatedBy: string
): Promise<FileRecord> {
  if (from === to) {
    throw new Error("Rename source and destination must differ");
  }

  const src = await getFile(db, from);
  if (!src || src.deleted === 1) {
    // Typed conflict, not an internal error: the source precondition fails.
    throw new ConflictError(
      from,
      src ? src.rev : 0,
      src ? src.hash : null,
      true,
      src ? src.updated_by : null
    );
  }

  if (src.rev !== baseRev) {
    throw new ConflictError(from, src.rev, src.hash, Boolean(src.deleted), src.updated_by);
  }

  const dst = await getFile(db, to);
  if (dst && dst.deleted === 0 && dst.rev > 0) {
    // Destination is occupied by an active file; refuse to overwrite
    throw new ConflictError(to, dst.rev, dst.hash, Boolean(dst.deleted), dst.updated_by);
  }

  const dstRev = dst ? dst.rev + 1 : 1;
  // -1 means "the destination must be absent"; otherwise it must still be the
  // exact tombstone revision this rename is overwriting.
  const dstTombstoneRev = dst ? dst.rev : -1;
  const srcRev = src.rev + 1;
  const srcMtime = Date.now();

  const results = await db.batch([
    // Destination seq.
    ...seqAdvance(db),
    db
      .prepare(RENAME_DST_SQL)
      .bind(
        to,
        dstRev,
        src.hash,
        src.size,
        src.mtime,
        src.folder,
        updatedBy,
        from,
        from,
        baseRev,
        0,
        to,
        to,
        dstTombstoneRev
      ),
    db.prepare(REVISION_INSERT_SQL).bind(to, dstRev),
    // Source tombstone seq (must sort after the destination change).
    ...seqAdvance(db),
    db
      .prepare(RENAME_SRC_SQL)
      .bind(from, srcRev, srcMtime, src.folder, updatedBy, from, baseRev, to, dstRev),
    db.prepare(REVISION_INSERT_SQL).bind(from, srcRev),
  ]);

  const newDst = batchRow(results, 2);
  if (!newDst) {
    // No destination row was published. Because the source statement requires
    // the destination's seq, nothing was applied. Report the precondition that
    // actually failed.
    const [actualSrc, actualDst] = await Promise.all([getFile(db, from), getFile(db, to)]);
    if (!actualSrc || actualSrc.deleted === 1 || actualSrc.rev !== baseRev) {
      throw new ConflictError(
        from,
        actualSrc ? actualSrc.rev : 0,
        actualSrc ? actualSrc.hash : null,
        actualSrc ? Boolean(actualSrc.deleted) : true,
        actualSrc ? actualSrc.updated_by : null
      );
    }
    throw new ConflictError(
      to,
      actualDst ? actualDst.rev : 0,
      actualDst ? actualDst.hash : null,
      actualDst ? Boolean(actualDst.deleted) : false,
      actualDst ? actualDst.updated_by : null
    );
  }

  const tombstone = batchRow(results, 6);
  if (!tombstone) {
    // Guarded by the destination publication inside the same transaction, so
    // this means the rename would have been half-applied. Fail loudly.
    throw new Error(`Rename ${from} -> ${to} published the destination without its source tombstone`);
  }

  return toRecord(newDst);
}

export async function getDeletedFiles(db: D1Database, limit: number = 200): Promise<DeletedFileEntry[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const rows = await db
    .prepare(
      `SELECT f.path, f.rev, f.mtime as deleted_at,
              (SELECT MAX(r.rev) FROM revisions r WHERE r.path = f.path AND r.hash IS NOT NULL) as content_rev,
              (SELECT r.hash FROM revisions r WHERE r.path = f.path AND r.hash IS NOT NULL ORDER BY r.rev DESC LIMIT 1) as hash
       FROM files f
       WHERE f.deleted = 1
       ORDER BY f.seq DESC
       LIMIT ?`
    )
    .bind(safeLimit)
    .all<{ path: string; rev: number; deleted_at: number; content_rev: number | null; hash: string | null }>();

  const results: DeletedFileEntry[] = [];
  for (const row of rows.results || []) {
    if (row.content_rev != null && row.hash != null) {
      results.push({
        path: row.path,
        rev: row.rev,
        deleted_at: row.deleted_at,
        content_rev: row.content_rev,
        hash: row.hash,
      });
    }
  }
  return results;
}

export async function purgeDeletedFiles(db: D1Database): Promise<{ files: number; bytes: number }> {
  const delFiles = await db
    .prepare("SELECT path, size FROM files WHERE deleted = 1")
    .all<{ path: string; size: number }>();

  const paths = (delFiles.results || []).map(f => f.path);
  if (paths.length === 0) {
    return { files: 0, bytes: 0 };
  }

  // Delete tombstones and old revisions
  for (const p of paths) {
    await db.batch([
      db.prepare("DELETE FROM files WHERE path = ?").bind(p),
      db.prepare("DELETE FROM revisions WHERE path = ?").bind(p),
    ]);
  }

  const totalBytes = (delFiles.results || []).reduce((acc, f) => acc + (f.size || 0), 0);
  return { files: paths.length, bytes: totalBytes };
}

export async function getRetentionDays(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'retention'").first<{ value: string }>();
  return row ? parseInt(row.value, 10) || 30 : 30;
}

export async function setRetentionDays(db: D1Database, days: number): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('retention', ?)")
    .bind(String(days))
    .run();
}

export async function getStats(db: D1Database): Promise<{
  files: number;
  deleted: number;
  folders: number;
  bytes: number;
  revisions: number;
  seq: number;
}> {
  const counts = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN deleted = 0 AND folder = 0 THEN 1 ELSE 0 END), 0) as files,
         COALESCE(SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END), 0) as deleted,
         COALESCE(SUM(CASE WHEN deleted = 0 AND folder = 1 THEN 1 ELSE 0 END), 0) as folders,
         COALESCE(SUM(CASE WHEN deleted = 0 THEN size ELSE 0 END), 0) as bytes
       FROM files`
    )
    .first<{ files: number; deleted: number; folders: number; bytes: number }>();

  const revCount = await db.prepare("SELECT COUNT(*) as revs FROM revisions").first<{ revs: number }>();
  const seq = await getCurrentSeq(db);

  return {
    files: counts?.files ?? 0,
    deleted: counts?.deleted ?? 0,
    folders: counts?.folders ?? 0,
    bytes: counts?.bytes ?? 0,
    revisions: revCount?.revs ?? 0,
    seq,
  };
}
