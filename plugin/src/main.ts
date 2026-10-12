// Obsidian plugin entrypoint.
// Connects vault filesystem events, status bar UI, commands, and scheduled sync cycles.

import { Notice, Plugin, TAbstractFile, TFile, requestUrl } from "obsidian";
import { SyncClient } from "./api";
import { LocalIndex, type StorageAdapter } from "./index-store";
import { isIgnored, normalizePath } from "./paths";
import { DEFAULT_SETTINGS, DistributedSyncSettingTab, type DistributedSyncSettings } from "./settings";
import { SyncEngine, type VaultAdapter } from "./sync-engine";

export default class DistributedSyncPlugin extends Plugin {
  settings: DistributedSyncSettings = DEFAULT_SETTINGS;
  private index!: LocalIndex;
  private client!: SyncClient;
  private engine!: SyncEngine;
  private statusBarItem!: HTMLElement;
  private isSyncing = false;
  private debounceTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Initialize local index
    const storageAdapter: StorageAdapter = {
      read: async (path: string) => {
        const fullPath = `.obsidian/plugins/obsidian-distributed-sync/${path}`;
        const exists = await this.app.vault.adapter.exists(fullPath);
        if (!exists) return null;
        return await this.app.vault.adapter.read(fullPath);
      },
      write: async (path: string, data: string) => {
        const fullPath = `.obsidian/plugins/obsidian-distributed-sync/${path}`;
        const dir = ".obsidian/plugins/obsidian-distributed-sync";
        if (!(await this.app.vault.adapter.exists(dir))) {
          await this.app.vault.adapter.mkdir(dir);
        }
        await this.app.vault.adapter.write(fullPath, data);
      },
    };

    this.index = new LocalIndex(storageAdapter, "state.json");
    await this.index.load();

    this.setupEngine();

    // UI: Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatus("idle");
    this.statusBarItem.onClickEvent(() => {
      this.triggerSync(true);
    });

    // UI: Ribbon Icon
    this.addRibbonIcon("refresh-cw", "Sync Vault", () => {
      this.triggerSync(true);
    });

    // Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.triggerSync(true),
    });

    this.addCommand({
      id: "check-status",
      name: "Check sync status",
      callback: async () => {
        if (!this.settings.token) {
          new Notice("Sync not configured: enter your server token in settings.");
          return;
        }
        try {
          const stats = await this.client.stats();
          new Notice(`Sync online: ${stats.files} files on server (seq: ${stats.seq})`);
        } catch (e) {
          new Notice(`Sync server error: ${e}`);
        }
      },
    });

    this.addSettingTab(new DistributedSyncSettingTab(this.app, this));

    // Register Vault Watchers
    this.registerEvent(this.app.vault.on("create", (file) => this.onFileCreated(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onFileModified(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onFileDeleted(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath)));

    // Register Polling Timer (default 30s)
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.autoSync) {
          this.triggerSync(false);
        }
      }, Math.max(this.settings.syncIntervalSeconds, 5) * 1000)
    );

    // Initial sync on startup
    if (this.settings.token) {
      setTimeout(() => this.triggerSync(false), 1500);
    }
  }

  private setupEngine(): void {
    this.client = new SyncClient(
      this.settings.serverUrl,
      this.settings.token,
      this.settings.deviceName,
      requestUrl
    );

    const vaultAdapter: VaultAdapter = {
      read: (path) => this.app.vault.adapter.read(path),
      readBinary: (path) => this.app.vault.adapter.readBinary(path),
      write: (path, text) => this.app.vault.adapter.write(path, text),
      writeBinary: (path, data) => this.app.vault.adapter.writeBinary(path, data),
      remove: (path) => this.app.vault.adapter.remove(path),
      rename: (from, to) => this.app.vault.adapter.rename(from, to),
      exists: (path) => this.app.vault.adapter.exists(path),
      mkdir: (path) => this.app.vault.adapter.mkdir(path),
      stat: async (path) => {
        const s = await this.app.vault.adapter.stat(path);
        return s ? { mtime: s.mtime, size: s.size } : null;
      },
    };

    this.engine = new SyncEngine({
      adapter: vaultAdapter,
      index: this.index,
      client: this.client,
      deviceName: this.settings.deviceName,
      excludes: this.settings.excludes,
      onConflict: (orig, conflict) => {
        new Notice(`Sync conflict on ${orig}. Saved remote version to ${conflict}`, 8000);
        this.updateStatus("conflict");
      },
      onLog: (msg) => {
        console.log(`[DistributedSync] ${msg}`);
      },
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.setupEngine();
  }

  private updateStatus(status: "idle" | "syncing" | "conflict" | "error"): void {
    if (!this.statusBarItem) return;
    switch (status) {
      case "syncing":
        this.statusBarItem.setText("🔄 Syncing...");
        break;
      case "conflict":
        this.statusBarItem.setText("⚠️ Sync conflict");
        break;
      case "error":
        this.statusBarItem.setText("❌ Sync error");
        break;
      default:
        this.statusBarItem.setText("✓ Synced");
        break;
    }
  }

  async triggerSync(manual = false): Promise<void> {
    if (this.isSyncing) return;
    if (!this.settings.token) {
      if (manual) new Notice("Sync token missing. Please set token in settings.");
      return;
    }

    this.isSyncing = true;
    this.updateStatus("syncing");

    try {
      const res = await this.engine.sync();
      if (res.conflicts > 0) {
        this.updateStatus("conflict");
      } else {
        this.updateStatus("idle");
      }
      if (manual) {
        new Notice(
          `Sync complete: ${res.pulled} pulled, ${res.pushed} pushed${
            res.conflicts > 0 ? `, ${res.conflicts} conflicts` : ""
          }`
        );
      }
    } catch (e) {
      console.error("Sync error:", e);
      this.updateStatus("error");
      if (manual) new Notice(`Sync failed: ${e}`);
    } finally {
      this.isSyncing = false;
    }
  }

  private scheduleDebouncedSync(): void {
    if (!this.settings.autoSync) return;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.triggerSync(false);
    }, 2000);
  }

  private onFileCreated(file: TAbstractFile): void {
    const path = normalizePath(file.path);
    if (isIgnored(path, this.settings.excludes)) return;
    const known = this.index.get(path);
    this.index.set(path, {
      base_rev: known?.base_rev ?? 0,
      base_hash: known?.base_hash ?? "",
      local_hash: "",
      mtime: Date.now(),
      dirty: true,
      folder: !(file instanceof TFile),
    });
    this.scheduleDebouncedSync();
  }

  private onFileModified(file: TAbstractFile): void {
    const path = normalizePath(file.path);
    if (isIgnored(path, this.settings.excludes)) return;
    const known = this.index.get(path);
    this.index.set(path, {
      base_rev: known?.base_rev ?? 0,
      base_hash: known?.base_hash ?? "",
      local_hash: "",
      mtime: Date.now(),
      dirty: true,
    });
    this.scheduleDebouncedSync();
  }

  private onFileDeleted(file: TAbstractFile): void {
    const path = normalizePath(file.path);
    if (isIgnored(path, this.settings.excludes)) return;
    const known = this.index.get(path);
    if (known) {
      this.index.set(path, {
        ...known,
        dirty: true,
      });
      this.scheduleDebouncedSync();
    }
  }

  private onFileRenamed(file: TAbstractFile, oldPath: string): void {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(file.path);
    if (isIgnored(oldNorm, this.settings.excludes) && isIgnored(newNorm, this.settings.excludes)) return;

    const known = this.index.get(oldNorm);
    if (known && known.base_rev > 0) {
      this.index.queueRename({ from: oldNorm, to: newNorm, base_rev: known.base_rev });
      this.index.set(newNorm, { ...known, dirty: known.dirty ?? false });
      this.index.remove(oldNorm);
    } else {
      this.onFileCreated(file);
    }
    this.scheduleDebouncedSync();
  }
}
