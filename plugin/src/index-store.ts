// Local index state store. Tracks base revisions, known hashes, dirty states, and sequence cursor.

export interface FileState {
  base_rev: number;
  base_path?: string;
  base_hash: string;
  local_hash: string;
  mtime: number;
  dirty?: boolean;
  folder?: boolean;
  /** Preserve a visible artifact before a rename into an excluded tree deletes this identity. */
  preserve_on_delete?: boolean;
  /** Historical base was already preserved during the current recovery. */
  recovery_preserved?: boolean;
}

export interface PendingRename {
  from: string;
  to: string;
  base_rev: number;
}

export interface IndexData {
  generation?: number;
  last_seq: number;
  files: Record<string, FileState>;
  pending_renames?: PendingRename[];
  recovery_pending?: boolean;
}

export interface StorageAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
}

export class LocalIndex {
  private data: IndexData = {
    last_seq: 0,
    files: Object.create(null),
    pending_renames: [],
  };
  private dirty = false;
  private revision = 0;
  private generation = 0;
  private saveQueue: Promise<void> = Promise.resolve();
  private adapter: StorageAdapter;
  private storagePath: string;

  constructor(adapter: StorageAdapter, storagePath = "sync-state.json") {
    this.adapter = adapter;
    this.storagePath = storagePath;
  }

  private parse(raw: string): IndexData {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || !Number.isSafeInteger(parsed.last_seq) || parsed.last_seq < 0
        || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)
        || (parsed.recovery_pending !== undefined && typeof parsed.recovery_pending !== "boolean")
        || (parsed.pending_renames !== undefined && !Array.isArray(parsed.pending_renames))
        || (parsed.generation !== undefined && (!Number.isSafeInteger(parsed.generation) || parsed.generation < 0))) {
      throw new Error("Invalid sync index schema");
    }
    for (const state of Object.values(parsed.files) as FileState[]) {
      if (!state || typeof state !== "object" || !Number.isSafeInteger(state.base_rev) || state.base_rev < 0
          || typeof state.base_hash !== "string" || typeof state.local_hash !== "string"
          || (state.base_path !== undefined && typeof state.base_path !== "string")
          || [state.folder, state.dirty, state.preserve_on_delete, state.recovery_preserved]
            .some((value) => value !== undefined && typeof value !== "boolean")
          || !Number.isFinite(state.mtime)) throw new Error("Invalid sync index entry");
    }
    for (const rename of parsed.pending_renames ?? []) {
      if (!rename || typeof rename.from !== "string" || typeof rename.to !== "string"
          || !Number.isSafeInteger(rename.base_rev) || rename.base_rev < 1) {
        throw new Error("Invalid sync index rename queue");
      }
    }
    return { generation: parsed.generation ?? 0, last_seq: parsed.last_seq, files: Object.assign(Object.create(null), parsed.files), pending_renames: parsed.pending_renames ?? [], recovery_pending: parsed.recovery_pending === true };
  }

  async load(): Promise<void> {
    let failure: unknown;
    let newest: { data: IndexData; backup: boolean } | undefined;
    for (const path of [this.storagePath, this.storagePath + ".bak"]) {
      try {
        const raw = await this.adapter.read(path);
        if (raw === null) continue;
        const data = this.parse(raw);
        // A failed primary publication can leave a valid but older primary.
        // Equal generations prefer the primary (including legacy generation 0).
        if (!newest || data.generation! > newest.data.generation!) {
          newest = { data, backup: path !== this.storagePath };
        }
      } catch (err) {
        failure = err;
      }
    }
    if (newest) {
      this.data = newest.data;
      this.generation = this.data.generation!;
      if (newest.backup) this.data.recovery_pending = true;
      this.revision++;
      this.dirty = newest.backup;
      return;
    }
    if (failure) throw new Error(`Cannot recover sync index: ${String(failure)}`);
    this.data = { last_seq: 0, files: Object.create(null), pending_renames: [] };
    this.generation = 0;
    this.dirty = false;
  }

  async save(): Promise<void> {
    // Serialize writes: an older, slower save must never overwrite a newer one.
    const save = this.saveQueue.then(async () => {
      if (!this.dirty) return;
      const revision = this.revision;
      if (this.generation === Number.MAX_SAFE_INTEGER) throw new Error("Sync index generation exhausted");
      const generation = ++this.generation;
      const payload = JSON.stringify({ ...this.data, generation }, null, 2);
      // Publish a recoverable snapshot before replacing the primary. If a
      // primary write is interrupted, the queued intent still exists here.
      await this.adapter.write(this.storagePath + ".bak", payload);
      await this.adapter.write(this.storagePath, payload);
      // Mutations while storage awaited still need a subsequent durable save.
      if (this.revision === revision) this.dirty = false;
    });
    this.saveQueue = save.catch(() => {});
    return save;
  }

  private changed(): void {
    this.revision++;
    this.dirty = true;
  }

  needsRecovery(): boolean {
    return this.data.recovery_pending === true;
  }

  finishRecovery(): void {
    for (const state of Object.values(this.data.files)) delete state.recovery_preserved;
    this.data.recovery_pending = false;
    this.changed();
  }

  getSeq(): number {
    return this.data.last_seq;
  }

  setSeq(seq: number): void {
    if (seq > this.data.last_seq) {
      this.data.last_seq = seq;
      this.changed();
    }
  }

  get(path: string): FileState | undefined {
    return this.data.files[path];
  }

  set(path: string, state: FileState): void {
    // Recovery progress belongs to this recovery pass, not to a transient
    // FileState object replaced by scans, edits or reconciliation.
    if (this.needsRecovery() && this.data.files[path]?.recovery_preserved) {
      state = { ...state, recovery_preserved: true };
    }
    this.data.files[path] = state;
    this.changed();
  }

  remove(path: string): void {
    if (path in this.data.files) {
      delete this.data.files[path];
      this.changed();
    }
  }

  allEntries(): [string, FileState][] {
    return Object.entries(this.data.files);
  }

  queueRename(rename: PendingRename): void {
    this.data.pending_renames = this.data.pending_renames || [];
    // Remove any existing rename for this source
    this.data.pending_renames = this.data.pending_renames.filter((r) => r.from !== rename.from);
    this.data.pending_renames.push(rename);
    this.changed();
  }

  getQueuedRenames(): PendingRename[] {
    return this.data.pending_renames || [];
  }

  clearQueuedRename(from: string): void {
    if (this.data.pending_renames) {
      this.data.pending_renames = this.data.pending_renames.filter((r) => r.from !== from);
      this.changed();
    }
  }
}
