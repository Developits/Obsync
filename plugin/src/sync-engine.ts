// Core reconciliation and synchronization engine.
// Implements three-way Myers merges, edit-beats-delete semantics, conflict file branching, and atomic CAS pushes.

import { ApiError, ConflictError, SyncClient, type ChangeEntry } from "./api.ts";
import { merge3 } from "./diff3.ts";
import { LocalIndex, type FileState } from "./index-store.ts";
import { generateConflictPath, isIgnored, normalizePath } from "./paths.ts";
import { errorMessage } from "./validation.ts";

export interface VaultAdapter {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, text: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  /**
   * Optional application-aware create for new conflict artifacts. Adapters
   * should reject known existing paths; the engine also reserves names since
   * application APIs need not provide OS-level exclusive-create semantics.
   */
  createBinary?(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  listFiles?(): Promise<string[]>;
}

export interface SyncEngineOptions {
  adapter: VaultAdapter;
  index: LocalIndex;
  client: SyncClient;
  deviceName: string;
  excludes?: string[];
  /** Host scheduler; headless callers may omit UI event-loop yielding. */
  yieldToEventLoop?: () => Promise<void>;
  onConflict?: (originalPath: string, conflictPath: string) => void;
  onLog?: (message: string) => void;
  onProgress?: (current: number, total: number, path: string) => void;
}

export interface SyncFailure {
  path: string;
  operation: "scan" | "pull" | "push" | "save";
  message: string;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  /** Operations that failed and still need attention. */
  failed: number;
  /** Paths still carrying unsynchronized work (dirty, queued rename, unreadable). */
  pending: number;
  errors: SyncFailure[];
}

export async function computeSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncEngine {
  private adapter: VaultAdapter;
  private index: LocalIndex;
  private client: SyncClient;
  private deviceName: string;
  private excludes: string[];
  private yieldToEventLoop: () => Promise<void>;
  private onConflict?: (originalPath: string, conflictPath: string) => void;
  private onLog?: (message: string) => void;
  private onProgress?: (current: number, total: number, path: string) => void;
  private scanFailures = new Set<string>();

  constructor(opts: SyncEngineOptions) {
    this.adapter = opts.adapter;
    this.index = opts.index;
    this.client = opts.client;
    this.deviceName = opts.deviceName;
    this.excludes = opts.excludes || [];
    this.yieldToEventLoop = opts.yieldToEventLoop ?? (() => Promise.resolve());
    this.onConflict = opts.onConflict;
    this.onLog = opts.onLog;
    this.onProgress = opts.onProgress;
  }

  private log(msg: string): void {
    if (this.onLog) this.onLog(msg);
  }

  /**
   * Main two-way synchronization cycle:
   * 1. Pull remote delta log from server.
   * 2. Reconcile any conflicts using 3-way merge or conflict files.
   * 3. Push local changes and renames with atomic compare-and-swap.
   */
  async sync(): Promise<SyncResult> {
    let pulledCount = 0;
    let pushedCount = 0;
    let conflictCount = 0;
    const errors: SyncFailure[] = [];
    this.scanFailures.clear();
    const messageOf = (err: unknown): string => err instanceof Error ? err.message : String(err);

    // Backup recovery restores identities, but local bytes may have changed
    // since that snapshot. Preserve their recorded remote bases visibly
    // before normal reconciliation, rather than trusting a recovered cursor
    // to mean the divergent versions have already been handled.
    if (this.index.needsRecovery()) {
      for (const [path, state] of this.index.allEntries()) {
        if (isIgnored(path, this.excludes) || state.folder || state.base_rev < 1 || state.recovery_preserved) continue;
        try {
          if (!await this.adapter.exists(path)) continue;
          const localHash = await computeSha256(await this.adapter.readBinary(path));
          if (localHash === state.base_hash) continue;
          const rename = this.index.getQueuedRenames().find((r) => normalizePath(r.to) === path);
          const remote = await this.client.getFile(state.base_path ?? rename?.from ?? path, state.base_rev);
          const copy = await this.preserveConflict(path, "index-recovery", remote.data);
          this.index.set(path, { ...this.index.get(path)!, recovery_preserved: true });
          this.onConflict?.(path, copy);
          conflictCount++;
        } catch (err) {
          this.scanFailures.add(path);
          errors.push({ path, operation: "scan", message: `Index recovery: ${messageOf(err)}` });
        }
      }
      if (this.scanFailures.size === 0) this.index.finishRecovery();
    }

    // Directories are derived from file paths, never uploaded as binary data.
    for (const [path, state] of this.index.allEntries()) {
      if (state.folder) this.index.remove(path);
    }
    // Phase 0: Reconcile local vault files with index (discovers pre-existing and externally modified files)
    if (this.adapter.listFiles) {
      const diskPaths = await this.adapter.listFiles();
      const diskSet = new Set<string>();
      for (const p of diskPaths) {
        const norm = normalizePath(p);
        if (isIgnored(norm, this.excludes)) continue;
        diskSet.add(norm);
        try {
          const known = this.index.get(norm);
          if (!known) {
            // Untracked pre-existing file: mark dirty with base_rev 0
            const stat = await this.adapter.stat(norm);
            this.index.set(norm, {
              base_rev: 0,
              base_hash: "",
              local_hash: "",
              mtime: stat?.mtime ?? Date.now(),
              dirty: true,
            });
          } else if (!known.dirty) {
            // Mtime is not a correctness proof: editors may preserve it, and
            // remote timestamps may be skewed. Verify bytes before pulling.
            const stat = await this.adapter.stat(norm);
            const hash = await computeSha256(await this.adapter.readBinary(norm));
            if (hash !== known.base_hash) {
              this.index.set(norm, { ...known, dirty: true, local_hash: hash, mtime: stat?.mtime ?? Date.now() });
            }
          }
        } catch (err) {
          // One unreadable file must not abort discovery for the rest of the
          // vault. Mark it dirty so it stays pending, and remember it so no
          // destructive incoming write touches this path this cycle.
          this.scanFailures.add(norm);
          if (!this.index.get(norm)) {
            this.index.set(norm, { base_rev: 0, base_hash: "", local_hash: "", mtime: Date.now(), dirty: true });
          } else {
            this.index.set(norm, { ...this.index.get(norm)!, dirty: true });
          }
          errors.push({ path: norm, operation: "scan", message: messageOf(err) });
        }
      }
      // Detect deletion done outside Obsidian while plugin was inactive
      for (const [path, state] of this.index.allEntries()) {
        if (isIgnored(path, this.excludes)) continue;
        if (!diskSet.has(path) && state.base_rev > 0 && !state.dirty) {
          this.index.set(path, { ...state, dirty: true });
        }
      }
    }

    // Phase 1: Pull remote changes
    const pullChanges = async () => {
      let hasMore = true;
      while (hasMore) {
        const startSeq = this.index.getSeq();
        const page = await this.client.changes(startSeq, 500);
        // The checkpoint may only advance across entries that were handled.
        // Entries after a failed one are still processed (unrelated progress)
        // but the cursor stops before the failure so it is retried.
        let contiguousSeq = startSeq;
        let blocked = false;
        for (const entry of page.entries) {
          try {
            const handled = await this.applyRemoteChange(entry);
            if (handled.conflict) conflictCount++;
            if (handled.failed) {
              blocked = true;
              errors.push({ path: normalizePath(entry.path), operation: "pull", message: "path has unreadable local content" });
            } else {
              pulledCount++;
              if (!blocked) contiguousSeq = entry.seq;
            }
          } catch (err) {
            blocked = true;
            errors.push({ path: normalizePath(entry.path), operation: "pull", message: messageOf(err) });
          }
        }
        // Only contiguous, fully handled entries certify the checkpoint.
        this.index.setSeq(contiguousSeq);
        if (blocked) break;
        hasMore = page.has_more;
        if (page.entries.length === 0) break;
        if (page.next_seq <= startSeq) break;
      }
    };
    await pullChanges();

    // Phase 2: Push queued renames
    const queuedRenames = this.index.getQueuedRenames();
    for (const rename of queuedRenames) {
      // Failed historical recovery protects both identities, including the
      // semantic-conflict fallback which otherwise discards the base tuple.
      if (this.scanFailures.has(normalizePath(rename.from)) || this.scanFailures.has(normalizePath(rename.to))) continue;
      try {
        const res = await this.client.rename(rename.from, rename.to, rename.base_rev);
        this.index.clearQueuedRename(rename.from);
        const known = this.index.get(rename.to);
        if (known) {
          this.index.set(rename.to, {
            ...known,
            base_rev: res.rev,
            base_hash: res.hash,
            // The acknowledged revision belongs to the destination path;
            // the old source path is no longer a valid merge base pair.
            base_path: undefined,
            // A rename acknowledges metadata, not pending local content.
            dirty: known.dirty ?? false,
          });
        }
        // A rename acknowledges one identity, not whatever now occupies the
        // vacated source path. A new file created at the reused path must keep
        // its own index entry (and therefore its pending upload).
        const sourceNow = this.index.get(rename.from);
        if (sourceNow && sourceNow.base_rev === rename.base_rev) {
          this.index.remove(rename.from);
        }
        // Write acknowledgments do not advance the pull checkpoint.
        pushedCount++;
      } catch (err) {
        // Resolve only a semantic conflict/missing source. Transport and auth
        // failures remain queued, never silently converted to new uploads.
        let missingSource = false;
        try { await this.client.getFile(rename.from); }
        catch (probe) { missingSource = probe instanceof ApiError && probe.status === 404; }
        if ((err instanceof ConflictError || missingSource) && await this.adapter.exists(rename.to)) {
          let destination;
          try { destination = await this.client.getFile(rename.to); }
          catch (probe) { if (!(probe instanceof ApiError && probe.status === 404)) throw probe; }
          if (destination) {
            const copy = await this.preserveConflict(rename.to, "remote", destination.data);
            this.onConflict?.(rename.to, copy);
          } else {
            this.onConflict?.(rename.from, rename.to);
          }
          const known = this.index.get(rename.to);
          this.index.set(rename.to, {
            ...known, base_rev: destination?.rev ?? 0,
            base_path: undefined,
            base_hash: destination?.hash ?? "", local_hash: "", mtime: Date.now(), dirty: true,
          });
          this.index.clearQueuedRename(rename.from);
          conflictCount++;
        } else {
          this.log(`Failed to push rename: ${errorMessage(err)}`);
        }
      }
    }

    // Phase 3: Push local modifications and deletions
    const dirtyEntries = Array.from(this.index.allEntries()).filter(
      ([path, state]) => state.dirty && !isIgnored(path, this.excludes)
    );
    const totalDirty = dirtyEntries.length;
    let dirtyProgressIndex = 0;

    for (const [path, state] of dirtyEntries) {
      dirtyProgressIndex++;
      if (this.onProgress) {
        this.onProgress(dirtyProgressIndex, totalDirty, path);
      }

      // Yield event loop briefly every 10 files to keep UI responsive on large vaults
      if (dirtyProgressIndex % 10 === 0) {
        await this.yieldToEventLoop();
      }

      try {
        // Unreadable local bytes: do not attempt a destructive push (and let
        // the scan/pull failures above describe why it is pending).
        if (this.scanFailures.has(path)) continue;
        // This state's revision still belongs to the source identity until
        // the queued rename succeeds or is explicitly reconciled.
        if (this.index.getQueuedRenames().some((rename) => normalizePath(rename.to) === path)) continue;
        const fileExists = await this.adapter.exists(path);
        if (!fileExists) {
          // Local deletion
          try {
            await this.client.deleteFile(path, state.base_rev);
            this.index.remove(path);
            // Write acknowledgments do not advance the pull checkpoint.
            pushedCount++;
          } catch (err) {
            if (err instanceof ConflictError) {
              // Edit on server beats local deletion! Restore local file from server
              await this.reconcileRemoteEdit(path, err.serverRev);
            } else {
              errors.push({ path, operation: "push", message: messageOf(err) });
              this.log(`Failed to push deletion of ${path}: ${errorMessage(err)}`);
            }
          }
        } else {
          // Local modification
          const data = await this.adapter.readBinary(path);
          // Worker 100MB limit guard
          if (data.byteLength > 100 * 1024 * 1024) {
            errors.push({ path, operation: "push", message: "file exceeds 100MB limit" });
            this.log(`Skipping ${path}: file exceeds 100MB limit`);
            continue;
          }

          const localHash = await computeSha256(data);
          if (localHash === state.base_hash && state.base_rev > 0) {
            // Content identical to base, clear dirty
            this.index.set(path, { ...state, dirty: false });
            continue;
          }

          const stat = await this.adapter.stat(path);
          const mtime = stat?.mtime ?? Date.now();

          try {
            const res = await this.client.putFile(path, state.base_rev, data, mtime);
            await this.acknowledgeUpload(path, res.rev, res.hash, mtime);
            // Write acknowledgments do not advance the pull checkpoint.
            pushedCount++;
          } catch (err) {
            if (err instanceof ConflictError) {
              // Concurrent edit on server! Reconcile
              try {
                const hadConflict = await this.reconcileConflict(path, state, data, err);
                if (hadConflict) conflictCount++;
              } catch (reconcileErr) {
                errors.push({ path, operation: "push", message: messageOf(reconcileErr) });
              }
            } else {
              errors.push({ path, operation: "push", message: messageOf(err) });
              this.log(`Failed to push edit for ${path}: ${errorMessage(err)}`);
            }
          }
        }
      } catch (err) {
        // A per-file failure (unreadable bytes, vanished file) must not abort
        // the rest of the vault; report it and continue with other paths.
        errors.push({ path, operation: "push", message: messageOf(err) });
      }
    }

    await pullChanges();
    try {
      await this.index.save();
    } catch (err) {
      // Persistence failure is a real failure, never a silent success.
      errors.push({ path: "", operation: "save", message: messageOf(err) });
      this.log(`Failed to persist sync index: ${errorMessage(err)}`);
    }

    let pending = 0;
    for (const [path, state] of this.index.allEntries()) {
      if (state.dirty && !isIgnored(path, this.excludes) && !this.scanFailures.has(path)) pending++;
    }
    pending += this.index.getQueuedRenames().length;
    pending += this.scanFailures.size;

    return {
      pulled: pulledCount,
      pushed: pushedCount,
      conflicts: conflictCount,
      failed: errors.length,
      pending,
      errors,
    };
  }

  private async acknowledgeUpload(path: string, rev: number, hash: string, mtime: number): Promise<void> {
    const rename = this.index.getQueuedRenames().find((r) => r.from === path);
    const target = rename?.to ?? path;
    if (rename) this.index.queueRename({ ...rename, base_rev: rev });
    const before = this.index.get(target);
    const exists = await this.adapter.exists(target);
    const localHash = exists ? await computeSha256(await this.adapter.readBinary(target)) : "";
    const current = this.index.get(target);
    this.index.set(target, {
      ...current,
      base_rev: rev,
      base_hash: hash,
      base_path: undefined,
      local_hash: localHash,
      mtime,
      dirty: !exists || localHash !== hash || before !== current,
    });
  }

  private async applyRemoteChange(entry: ChangeEntry): Promise<{ conflict: boolean; failed?: boolean }> {
    const path = normalizePath(entry.path);
    if (isIgnored(path, this.excludes) || entry.folder) {
      if (entry.renamed_from && !entry.deleted && !entry.folder) {
        const source = normalizePath(entry.renamed_from);
        const known = this.index.get(source);
        if (known && known.base_rev > 0 && !isIgnored(source, this.excludes)) {
          // Persist this observed intent across pagination/restart. A latest-
          // entry feed can hide source -> ignored -> ignored lineage before
          // we observe it; this is not a blanket artifact guarantee for such
          // moves. The source tombstone decides whether it may be removed.
          this.index.set(source, { ...known, preserve_on_delete: true });
        }
      }
      return { conflict: false };
    }
    // Unreadable local bytes make every incoming write for this path unsafe
    // (we cannot prove what we would overwrite). Leave it pending; unrelated
    // paths still make progress.
    if (this.scanFailures.has(path)) {
      return { conflict: false, failed: true };
    }

    // A local queued destination is not the remote file currently at that
    // path. Resolve it in phase 2 against the current server destination,
    // preserving both versions instead of overwriting it during phase 1.
    if (this.index.getQueuedRenames().some((rename) => normalizePath(rename.to) === path)) {
      return { conflict: false };
    }

    // Follow an advertised rename before handling its source tombstone.
    if (entry.renamed_from && !this.index.get(path)) {
      const source = normalizePath(entry.renamed_from);
      const previous = this.index.get(source);
      // Proven lineage only: the local entry must be a real, previously
      // synchronized revision whose recorded base content is exactly the
      // content the server moved. Untracked local notes (base_rev 0) and
      // entries from an older/different base are never adopted.
      const provenLineage = previous !== undefined && previous.base_rev > 0
        && Boolean(previous.base_hash) && Boolean(entry.hash)
        && previous.base_hash === entry.hash;
      if (provenLineage && !this.scanFailures.has(source)
          && !isIgnored(source, this.excludes) && await this.adapter.exists(source)
          && !(await this.adapter.exists(path))) {
        await this.ensureParentDir(path);
        await this.adapter.rename(source, path);
        this.index.remove(source);
        this.index.set(path, { ...previous, base_path: source });
      }
    }
    const known = this.index.get(path);

    // Skip echo of our own upload
    if (entry.updated_by === this.deviceName && known && known.base_rev === entry.rev) {
      return { conflict: false };
    }

    const fileExists = await this.adapter.exists(path);

    // 1. Remote Deletion
    if (entry.deleted) {
      // An older tombstone than the revision we already hold is a stale echo
      // (for example our own edit-beats-delete revival). Applying it would
      // delete bytes that are newer than the tombstone.
      if (known && known.base_rev > entry.rev) {
        return { conflict: false };
      }
      if (known?.dirty && fileExists) {
        // Edit beats deletion! Keep local file and advance base_rev to tombstone so push revives it
        this.log(`Edit beats deletion: keeping locally edited ${path}`);
        this.index.set(path, {
          ...known,
          base_rev: entry.rev,
          // The base revision is a tombstone: the preserved bytes are no
          // longer the server's content, so force a real upload/revival.
          base_hash: "",
          base_path: undefined,
          dirty: true,
        });
        return { conflict: false };
      }
      let preserved = false;
      if (fileExists) {
        // Destruction is only safe for the exact tracked identity being
        // tombstoned: same lineage (base rev immediately before the tombstone)
        // and no dirty local content. Anything else at this path is either a
        // reused name or unrelated local bytes and must be preserved.
        const sameIdentity = known !== undefined && known.base_rev > 0
          && known.base_rev === entry.rev - 1 && !known.dirty;
        if (!sameIdentity) {
          this.log(`Keeping untracked/divergent local bytes at tombstoned path ${path}`);
          this.index.set(path, {
            ...(known ?? { base_rev: 0, base_hash: "", local_hash: "", mtime: Date.now() }),
            base_rev: entry.rev,
            base_hash: "",
            base_path: undefined,
            dirty: true,
          });
          return { conflict: false };
        }
        const currentHash = await computeSha256(await this.adapter.readBinary(path));
        if (known.base_hash && currentHash !== known.base_hash) {
          // Bytes changed since the decision was made: never destroy them.
          this.index.set(path, { ...known, base_rev: entry.rev, base_hash: "", base_path: undefined, dirty: true });
          return { conflict: false };
        }
        if (known.preserve_on_delete) {
          const copy = await this.preserveConflict(path, "excluded-rename", await this.adapter.readBinary(path));
          preserved = true;
          this.onConflict?.(path, copy);
          // Creating the artifact awaits I/O: a subsequent local edit must
          // not be removed merely because the earlier version was preserved.
          if (await this.localHashOrNull(path) !== currentHash) {
            this.index.set(path, { ...known, base_rev: entry.rev, base_hash: "", base_path: undefined, dirty: true });
            return { conflict: true };
          }
        }
        await this.adapter.remove(path);
      }
      this.index.remove(path);
      return { conflict: preserved };
    }

    // 2. Remote Modification or Creation
    if (!known?.dirty || !fileExists) {
      // A remote edit beats a pending local deletion; there are no local
      // bytes to merge when the file is absent.
      // Snapshot the bytes the decision is based on. Any change to the local
      // file while the download is in flight must not be overwritten.
      const snapshot = fileExists ? await computeSha256(await this.adapter.readBinary(path)) : null;
      const remote = await this.client.getFile(path, entry.rev);
      const current = await this.localHashOrNull(path);
      if (current !== snapshot) {
        this.log(`Local content changed while downloading ${path}; preserving both versions`);
        const copy = await this.preserveConflict(path, entry.updated_by || "remote", remote.data);
        this.onConflict?.(path, copy);
        this.index.set(path, {
          ...(known ?? { base_rev: 0, base_hash: "", local_hash: "", mtime: Date.now() }),
          base_rev: entry.rev,
          base_path: undefined,
          dirty: true,
        });
        return { conflict: true };
      }
      await this.ensureParentDir(path);
      await this.adapter.writeBinary(path, remote.data);
      this.index.set(path, {
        base_rev: entry.rev,
        base_hash: remote.hash,
        local_hash: remote.hash,
        mtime: entry.mtime,
        dirty: false,
      });
      return { conflict: false };
    }

    // 3. Local is dirty AND remote changed: CONFLICT RECONCILIATION
    const localData = await this.adapter.readBinary(path);
    const localHash = await computeSha256(localData);

    // If local has exact same hash as remote, resolve cleanly
    if (localHash === entry.hash) {
      this.index.set(path, {
        base_rev: entry.rev,
        base_hash: entry.hash,
        local_hash: localHash,
        mtime: entry.mtime,
        dirty: false,
      });
      return { conflict: false };
    }

    const isMarkdown = path.endsWith(".md");
    if (isMarkdown && known.base_rev > 0) {
      // Try 3-way Myers diff3 merge
      try {
        const [baseFile, remoteFile] = await Promise.all([
          this.client.getFile(known.base_path ?? path, known.base_rev),
          this.client.getFile(path, entry.rev),
        ]);

        const decoder = new TextDecoder();
        const baseText = decoder.decode(baseFile.data);
        const remoteText = decoder.decode(remoteFile.data);
        const localText = decoder.decode(localData);

        const merged = merge3(baseText, localText, remoteText, this.deviceName, entry.updated_by || "remote");

        if (merged.clean) {
          const currentHash = await this.localHashOrNull(path);
          if (currentHash !== localHash) {
            // The user kept typing while the merge downloaded. Abort the
            // overwrite, keep the local bytes pending, and preserve the remote
            // version as an explicit conflict copy.
            this.log(`Local content changed during merge of ${path}; deferring to a later sync`);
            const copy = await this.preserveConflict(path, entry.updated_by || "remote", remoteFile.data);
            this.onConflict?.(path, copy);
            this.index.set(path, {
              ...known,
              base_rev: entry.rev,
              base_path: undefined,
              dirty: true,
            });
            return { conflict: true };
          }
          // Clean 3-way merge! Write merged text and mark dirty to push converged revision
          await this.adapter.write(path, merged.text);
          const newHash = await computeSha256(new TextEncoder().encode(merged.text).buffer);
          this.index.set(path, {
            base_rev: entry.rev,
            base_hash: entry.hash || remoteFile.hash,
            local_hash: newHash,
            mtime: Date.now(),
            dirty: true,
          });
          this.log(`Clean 3-way merge auto-applied for ${path}`);
          return { conflict: false };
        }
      } catch (e) {
        this.log(`diff3 failed for ${path}, falling back to conflict file: ${errorMessage(e)}`);
      }
    }

    // Overlapping conflict or binary file: Create sibling conflict file
    const remoteFile = await this.client.getFile(path, entry.rev);
    const conflictPath = await this.preserveConflict(path, entry.updated_by || "remote", remoteFile.data);

    // Keep local file in place and record conflict
    if (this.onConflict) {
      this.onConflict(path, conflictPath);
    }
    this.log(`Conflict detected on ${path}. Preserved local; remote saved to ${conflictPath}`);

    // Update base_rev so subsequent sync attempts are based on the latest server version
    this.index.set(path, {
      ...known,
      base_rev: entry.rev,
      base_path: undefined,
      dirty: true,
    });

    return { conflict: true };
  }

  private async reconcileConflict(
    path: string,
    state: FileState,
    localData: ArrayBuffer,
    conflict: ConflictError
  ): Promise<boolean> {
    const localHash = await computeSha256(localData);
    const isMarkdown = path.endsWith(".md");
    if (isMarkdown && state.base_rev > 0 && !conflict.deleted) {
      try {
        const [baseFile, serverFile] = await Promise.all([
          this.client.getFile(state.base_path ?? path, state.base_rev),
          this.client.getFile(path, conflict.serverRev),
        ]);

        const decoder = new TextDecoder();
        const baseText = decoder.decode(baseFile.data);
        const serverText = decoder.decode(serverFile.data);
        const localText = decoder.decode(localData);

        const merged = merge3(baseText, localText, serverText, this.deviceName, conflict.serverDevice || "remote");
        if (merged.clean) {
          const currentHash = await this.localHashOrNull(path);
          if (currentHash !== localHash) {
            this.log(`Local content changed during merge of ${path}; preserving remote copy`);
            const copy = await this.preserveConflict(path, conflict.serverDevice || "remote", serverFile.data);
            this.onConflict?.(path, copy);
            this.index.set(path, {
              ...state,
              base_rev: conflict.serverRev,
              base_path: undefined,
              dirty: true,
            });
            return true;
          }
          await this.adapter.write(path, merged.text);
          const newHash = await computeSha256(new TextEncoder().encode(merged.text).buffer);
          this.index.set(path, {
            base_rev: conflict.serverRev,
            base_hash: conflict.serverHash,
            local_hash: newHash,
            mtime: Date.now(),
            dirty: true,
          });
          return false;
        }
      } catch { /* Fall through to conflict-copy recovery when merging fails. */ }
    }

    if (conflict.deleted) {
      // Edit beats deletion: push local version based on tombstone rev
      try {
        const stat = await this.adapter.stat(path);
        const mtime = stat?.mtime ?? Date.now();
        const res = await this.client.putFile(path, conflict.serverRev, localData, mtime);
        this.index.set(path, {
          base_rev: res.rev,
          base_hash: res.hash,
          local_hash: res.hash,
          mtime,
          dirty: false,
        });
        // Write acknowledgments do not advance the pull checkpoint.
        this.log(`Edit beats deletion: revived ${path} on server`);
        return false;
      } catch (e) {
        this.log(`Failed to revive deleted file ${path}: ${errorMessage(e)}`);
      }
    }

    // Create conflict file for server's version
    const serverFile = await this.client.getFile(path, conflict.serverRev);
    const conflictPath = await this.preserveConflict(path, conflict.serverDevice || "remote", serverFile.data);
    if (this.onConflict) this.onConflict(path, conflictPath);

    // Advance base_rev to server's revision so local edit can be re-pushed
    this.index.set(path, {
      ...state,
      base_rev: conflict.serverRev,
      base_path: undefined,
      dirty: true,
    });

    return true;
  }

  private async reconcileRemoteEdit(path: string, serverRev: number): Promise<void> {
    const remote = await this.client.getFile(path, serverRev);
    // If another local write recreated the path while we were restoring a
    // deletion, keep it and preserve the server version as a conflict copy.
    const existing = await this.localHashOrNull(path);
    if (existing !== null) {
      const copy = await this.preserveConflict(path, "remote", remote.data);
      this.onConflict?.(path, copy);
      const known = this.index.get(path);
      this.index.set(path, {
        ...(known ?? { base_rev: 0, base_hash: "", local_hash: "", mtime: Date.now() }),
        base_rev: serverRev,
        base_path: undefined,
        dirty: true,
      });
      return;
    }
    await this.ensureParentDir(path);
    await this.adapter.writeBinary(path, remote.data);
    this.index.set(path, {
      base_rev: serverRev,
      base_hash: remote.hash,
      local_hash: remote.hash,
      mtime: Date.now(),
      dirty: false,
    });
  }

  private readonly conflictReservations = new Set<string>();

  private async preserveConflict(path: string, device: string, data: ArrayBuffer): Promise<string> {
    const base = generateConflictPath(path, device);
    const dot = base.lastIndexOf(".");
    const split = dot > base.lastIndexOf("/") ? dot : base.length;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base.slice(0, split)} (${n})${base.slice(split)}`;
      // Reserve before the first await. Vault.createBinary is not an atomic
      // OS-level exclusive create; two calls can both pass its cache check.
      if (this.conflictReservations.has(candidate)) continue;
      this.conflictReservations.add(candidate);
      try {
        if (await this.adapter.exists(candidate)) continue;
        await this.ensureParentDir(candidate);
        if (this.adapter.createBinary) {
          try { await this.adapter.createBinary(candidate, data); }
          catch (err) {
            if (await this.adapter.exists(candidate)) continue;
            throw err;
          }
        } else {
          await this.adapter.writeBinary(candidate, data);
        }
        this.index.set(candidate, { base_rev: 0, base_hash: "", local_hash: "", mtime: Date.now(), dirty: true });
        return candidate;
      } finally {
        this.conflictReservations.delete(candidate);
      }
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash !== -1) {
      const dir = path.slice(0, lastSlash);
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
  }

  /** Hash of the current on-disk bytes, or null when the path is absent. */
  private async localHashOrNull(path: string): Promise<string | null> {
    if (!(await this.adapter.exists(path))) return null;
    return computeSha256(await this.adapter.readBinary(path));
  }
}
