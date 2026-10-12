// Core reconciliation and synchronization engine.
// Implements three-way Myers merges, edit-beats-delete semantics, conflict file branching, and atomic CAS pushes.

import { ConflictError, SyncClient, type ChangeEntry } from "./api.ts";
import { merge3 } from "./diff3.ts";
import { LocalIndex, type FileState } from "./index-store.ts";
import { generateConflictPath, isIgnored, normalizePath } from "./paths.ts";

export interface VaultAdapter {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, text: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
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
  onConflict?: (originalPath: string, conflictPath: string) => void;
  onLog?: (message: string) => void;
  onProgress?: (current: number, total: number, path: string) => void;
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
  private onConflict?: (originalPath: string, conflictPath: string) => void;
  private onLog?: (message: string) => void;
  private onProgress?: (current: number, total: number, path: string) => void;

  constructor(opts: SyncEngineOptions) {
    this.adapter = opts.adapter;
    this.index = opts.index;
    this.client = opts.client;
    this.deviceName = opts.deviceName;
    this.excludes = opts.excludes || [];
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
  async sync(): Promise<{ pulled: number; pushed: number; conflicts: number }> {
    let pulledCount = 0;
    let pushedCount = 0;
    let conflictCount = 0;

    // Phase 0: Reconcile local vault files with index (discovers pre-existing and externally modified files)
    if (this.adapter.listFiles) {
      const diskPaths = await this.adapter.listFiles();
      const diskSet = new Set<string>();
      for (const p of diskPaths) {
        const norm = normalizePath(p);
        if (isIgnored(norm, this.excludes)) continue;
        diskSet.add(norm);
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
          // Detect modification done outside Obsidian while plugin was inactive
          const stat = await this.adapter.stat(norm);
          if (stat && known.mtime && stat.mtime > known.mtime + 1000) {
            this.index.set(norm, { ...known, dirty: true, mtime: stat.mtime });
          }
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
    const initialSeq = this.index.getSeq();
    let hasMore = true;
    let currentSeq = initialSeq;

    while (hasMore) {
      const page = await this.client.changes(currentSeq, 500);
      for (const entry of page.entries) {
        const handled = await this.applyRemoteChange(entry);
        if (handled.conflict) conflictCount++;
        pulledCount++;
      }
      currentSeq = page.next_seq;
      this.index.setSeq(currentSeq);
      hasMore = page.has_more;
      if (page.entries.length === 0) break;
    }

    // Phase 2: Push queued renames
    const queuedRenames = this.index.getQueuedRenames();
    for (const rename of queuedRenames) {
      try {
        const res = await this.client.rename(rename.from, rename.to, rename.base_rev);
        this.index.clearQueuedRename(rename.from);
        const known = this.index.get(rename.to);
        if (known) {
          this.index.set(rename.to, {
            ...known,
            base_rev: res.rev,
            dirty: false,
          });
        }
        this.index.remove(rename.from);
        this.index.setSeq(res.seq);
        pushedCount++;
      } catch (err) {
        if (err instanceof ConflictError) {
          this.log(`Rename conflict on ${rename.from} -> ${rename.to}`);
        } else {
          this.log(`Failed to push rename: ${err}`);
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
        await new Promise((r) => setTimeout(r, 0));
      }

      const fileExists = await this.adapter.exists(path);
      if (!fileExists) {
        // Local deletion
        try {
          const res = await this.client.deleteFile(path, state.base_rev);
          this.index.remove(path);
          this.index.setSeq(res.seq);
          pushedCount++;
        } catch (err) {
          if (err instanceof ConflictError) {
            // Edit on server beats local deletion! Restore local file from server
            await this.reconcileRemoteEdit(path, err.serverRev);
          } else {
            this.log(`Failed to push deletion of ${path}: ${err}`);
          }
        }
      } else {
        // Local modification
        const data = await this.adapter.readBinary(path);
        // Worker 100MB limit guard
        if (data.byteLength > 100 * 1024 * 1024) {
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
          this.index.set(path, {
            base_rev: res.rev,
            base_hash: res.hash,
            local_hash: res.hash,
            mtime,
            dirty: false,
          });
          this.index.setSeq(res.seq);
          pushedCount++;
        } catch (err) {
          if (err instanceof ConflictError) {
            // Concurrent edit on server! Reconcile
            const hadConflict = await this.reconcileConflict(path, state, data, err);
            if (hadConflict) conflictCount++;
          } else {
            this.log(`Failed to push edit for ${path}: ${err}`);
          }
        }
      }
    }

    await this.index.save();
    return { pulled: pulledCount, pushed: pushedCount, conflicts: conflictCount };
  }

  private async applyRemoteChange(entry: ChangeEntry): Promise<{ conflict: boolean }> {
    const path = normalizePath(entry.path);
    if (isIgnored(path, this.excludes)) {
      return { conflict: false };
    }

    const known = this.index.get(path);

    // Skip echo of our own upload
    if (entry.updated_by === this.deviceName && known && known.base_rev === entry.rev) {
      return { conflict: false };
    }

    const fileExists = await this.adapter.exists(path);

    // 1. Remote Deletion
    if (entry.deleted) {
      if (known?.dirty && fileExists) {
        // Edit beats deletion! Keep local file and advance base_rev to tombstone so push revives it
        this.log(`Edit beats deletion: keeping locally edited ${path}`);
        this.index.set(path, {
          ...known,
          base_rev: entry.rev,
          dirty: true,
        });
        return { conflict: false };
      }
      if (fileExists) {
        await this.adapter.remove(path);
      }
      this.index.remove(path);
      return { conflict: false };
    }

    // 2. Remote Modification or Creation
    if (!known?.dirty) {
      // Local is clean: accept remote version directly
      const remote = await this.client.getFile(path, entry.rev);
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
          this.client.getFile(path, known.base_rev),
          this.client.getFile(path, entry.rev),
        ]);

        const decoder = new TextDecoder();
        const baseText = decoder.decode(baseFile.data);
        const remoteText = decoder.decode(remoteFile.data);
        const localText = decoder.decode(localData);

        const merged = merge3(baseText, localText, remoteText, this.deviceName, entry.updated_by || "remote");

        if (merged.clean) {
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
        this.log(`diff3 failed for ${path}, falling back to conflict file: ${e}`);
      }
    }

    // Overlapping conflict or binary file: Create sibling conflict file
    const remoteFile = await this.client.getFile(path, entry.rev);
    const conflictPath = generateConflictPath(path, entry.updated_by || "remote");
    await this.ensureParentDir(conflictPath);
    await this.adapter.writeBinary(conflictPath, remoteFile.data);

    // Keep local file in place and record conflict
    if (this.onConflict) {
      this.onConflict(path, conflictPath);
    }
    this.log(`Conflict detected on ${path}. Preserved local; remote saved to ${conflictPath}`);

    // Update base_rev so subsequent sync attempts are based on the latest server version
    this.index.set(path, {
      ...known,
      base_rev: entry.rev,
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
    const isMarkdown = path.endsWith(".md");
    if (isMarkdown && state.base_rev > 0 && !conflict.deleted) {
      try {
        const [baseFile, serverFile] = await Promise.all([
          this.client.getFile(path, state.base_rev),
          this.client.getFile(path, conflict.serverRev),
        ]);

        const decoder = new TextDecoder();
        const baseText = decoder.decode(baseFile.data);
        const serverText = decoder.decode(serverFile.data);
        const localText = decoder.decode(localData);

        const merged = merge3(baseText, localText, serverText, this.deviceName, conflict.serverDevice || "remote");
        if (merged.clean) {
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
      } catch {}
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
        this.index.setSeq(res.seq);
        this.log(`Edit beats deletion: revived ${path} on server`);
        return false;
      } catch (e) {
        this.log(`Failed to revive deleted file ${path}: ${e}`);
      }
    }

    // Create conflict file for server's version
    const serverFile = await this.client.getFile(path, conflict.serverRev);
    const conflictPath = generateConflictPath(path, conflict.serverDevice || "remote");
    await this.ensureParentDir(conflictPath);
    await this.adapter.writeBinary(conflictPath, serverFile.data);
    if (this.onConflict) this.onConflict(path, conflictPath);

    // Advance base_rev to server's revision so local edit can be re-pushed
    this.index.set(path, {
      ...state,
      base_rev: conflict.serverRev,
      dirty: true,
    });

    return true;
  }

  private async reconcileRemoteEdit(path: string, serverRev: number): Promise<void> {
    const remote = await this.client.getFile(path, serverRev);
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

  private async ensureParentDir(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash !== -1) {
      const dir = path.slice(0, lastSlash);
      await this.adapter.mkdir(dir);
    }
  }
}
