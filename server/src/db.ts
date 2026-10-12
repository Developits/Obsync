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
  if (cur && cur.deleted === 0 && cur.hash === file.hash && cur.folder === (file.folder ? 1 : 0)) {
    return { record: cur, isNoop: true };
  }

  // Compare-and-swap verification
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

  const nextSeq = await getNextSeq(db);
  const nextRev = currentRev + 1;

  const nextRecord: FileRecord = {
    path: file.path,
    rev: nextRev,
    seq: nextSeq,
    hash: file.folder ? null : file.hash,
    size: file.size,
    mtime: file.mtime,
    deleted: 0,
    folder: file.folder ? 1 : 0,
    updated_by: file.updatedBy,
    renamed_from: null,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO files (path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           rev = excluded.rev,
           seq = excluded.seq,
           hash = excluded.hash,
           size = excluded.size,
           mtime = excluded.mtime,
           deleted = excluded.deleted,
           folder = excluded.folder,
           updated_by = excluded.updated_by,
           renamed_from = excluded.renamed_from`
      )
      .bind(
        nextRecord.path,
        nextRecord.rev,
        nextRecord.seq,
        nextRecord.hash,
        nextRecord.size,
        nextRecord.mtime,
        nextRecord.deleted,
        nextRecord.folder,
        nextRecord.updated_by,
        nextRecord.renamed_from
      ),
    db
      .prepare(
        `INSERT INTO revisions (path, rev, hash, mtime, seq)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, rev) DO NOTHING`
      )
      .bind(nextRecord.path, nextRecord.rev, nextRecord.hash, nextRecord.mtime, nextRecord.seq),
  ]);

  return { record: nextRecord, isNoop: false };
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

  const nextSeq = await getNextSeq(db);
  const nextRev = currentRev + 1;

  const tombstone: FileRecord = {
    path,
    rev: nextRev,
    seq: nextSeq,
    hash: null,
    size: 0,
    mtime: Date.now(),
    deleted: 1,
    folder: cur ? cur.folder : 0,
    updated_by: updatedBy,
    renamed_from: null,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO files (path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           rev = excluded.rev,
           seq = excluded.seq,
           hash = excluded.hash,
           size = excluded.size,
           mtime = excluded.mtime,
           deleted = excluded.deleted,
           folder = excluded.folder,
           updated_by = excluded.updated_by,
           renamed_from = excluded.renamed_from`
      )
      .bind(
        tombstone.path,
        tombstone.rev,
        tombstone.seq,
        tombstone.hash,
        tombstone.size,
        tombstone.mtime,
        tombstone.deleted,
        tombstone.folder,
        tombstone.updated_by,
        tombstone.renamed_from
      ),
    db
      .prepare(
        `INSERT INTO revisions (path, rev, hash, mtime, seq)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, rev) DO NOTHING`
      )
      .bind(tombstone.path, tombstone.rev, tombstone.hash, tombstone.mtime, tombstone.seq),
  ]);

  return tombstone;
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
    throw new Error(`Source file not found: ${from}`);
  }

  if (src.rev !== baseRev) {
    throw new ConflictError(from, src.rev, src.hash, Boolean(src.deleted), src.updated_by);
  }

  const dst = await getFile(db, to);
  if (dst && dst.deleted === 0 && dst.rev > 0) {
    // Destination is occupied by an active file; refuse to overwrite
    throw new ConflictError(to, dst.rev, dst.hash, Boolean(dst.deleted), dst.updated_by);
  }

  const seqDst = await getNextSeq(db);
  const dstRev = dst ? dst.rev + 1 : 1;

  const newDst: FileRecord = {
    path: to,
    rev: dstRev,
    seq: seqDst,
    hash: src.hash,
    size: src.size,
    mtime: src.mtime,
    deleted: 0,
    folder: src.folder,
    updated_by: updatedBy,
    renamed_from: from,
  };

  const seqSrc = await getNextSeq(db);
  const tombSrc: FileRecord = {
    path: from,
    rev: src.rev + 1,
    seq: seqSrc,
    hash: null,
    size: 0,
    mtime: Date.now(),
    deleted: 1,
    folder: src.folder,
    updated_by: updatedBy,
    renamed_from: null,
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO files (path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           rev = excluded.rev, seq = excluded.seq, hash = excluded.hash, size = excluded.size,
           mtime = excluded.mtime, deleted = excluded.deleted, folder = excluded.folder,
           updated_by = excluded.updated_by, renamed_from = excluded.renamed_from`
      )
      .bind(
        newDst.path,
        newDst.rev,
        newDst.seq,
        newDst.hash,
        newDst.size,
        newDst.mtime,
        newDst.deleted,
        newDst.folder,
        newDst.updated_by,
        newDst.renamed_from
      ),
    db
      .prepare(
        `INSERT INTO revisions (path, rev, hash, mtime, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, rev) DO NOTHING`
      )
      .bind(newDst.path, newDst.rev, newDst.hash, newDst.mtime, newDst.seq),
    db
      .prepare(
        `INSERT INTO files (path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           rev = excluded.rev, seq = excluded.seq, hash = excluded.hash, size = excluded.size,
           mtime = excluded.mtime, deleted = excluded.deleted, folder = excluded.folder,
           updated_by = excluded.updated_by, renamed_from = excluded.renamed_from`
      )
      .bind(
        tombSrc.path,
        tombSrc.rev,
        tombSrc.seq,
        tombSrc.hash,
        tombSrc.size,
        tombSrc.mtime,
        tombSrc.deleted,
        tombSrc.folder,
        tombSrc.updated_by,
        tombSrc.renamed_from
      ),
    db
      .prepare(
        `INSERT INTO revisions (path, rev, hash, mtime, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, rev) DO NOTHING`
      )
      .bind(tombSrc.path, tombSrc.rev, tombSrc.hash, tombSrc.mtime, tombSrc.seq),
  ]);

  return newDst;
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
