// Local index state store. Tracks base revisions, known hashes, dirty states, and sequence cursor.

export interface FileState {
  base_rev: number;
  base_hash: string;
  local_hash: string;
  mtime: number;
  dirty?: boolean;
  folder?: boolean;
}

export interface PendingRename {
  from: string;
  to: string;
  base_rev: number;
}

export interface IndexData {
  last_seq: number;
  files: Record<string, FileState>;
  pending_renames?: PendingRename[];
}

export interface StorageAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
}

export class LocalIndex {
  private data: IndexData = {
    last_seq: 0,
    files: {},
    pending_renames: [],
  };
  private dirty = false;
  private adapter: StorageAdapter;
  private storagePath: string;

  constructor(adapter: StorageAdapter, storagePath = "sync-state.json") {
    this.adapter = adapter;
    this.storagePath = storagePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await this.adapter.read(this.storagePath);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = {
          last_seq: Number(parsed.last_seq || 0),
          files: parsed.files || {},
          pending_renames: parsed.pending_renames || [],
        };
      }
    } catch {
      // If missing or unreadable, start fresh
      this.data = { last_seq: 0, files: {}, pending_renames: [] };
    }
    this.dirty = false;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await this.adapter.write(this.storagePath, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (e) {
      console.error("Failed to persist sync index:", e);
    }
  }

  getSeq(): number {
    return this.data.last_seq;
  }

  setSeq(seq: number): void {
    if (seq > this.data.last_seq) {
      this.data.last_seq = seq;
      this.dirty = true;
    }
  }

  get(path: string): FileState | undefined {
    return this.data.files[path];
  }

  set(path: string, state: FileState): void {
    this.data.files[path] = state;
    this.dirty = true;
  }

  remove(path: string): void {
    if (path in this.data.files) {
      delete this.data.files[path];
      this.dirty = true;
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
    this.dirty = true;
  }

  getQueuedRenames(): PendingRename[] {
    return this.data.pending_renames || [];
  }

  clearQueuedRename(from: string): void {
    if (this.data.pending_renames) {
      this.data.pending_renames = this.data.pending_renames.filter((r) => r.from !== from);
      this.dirty = true;
    }
  }
}
