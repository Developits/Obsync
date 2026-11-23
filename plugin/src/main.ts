// Obsidian plugin entrypoint.
// Connects vault filesystem events, status bar UI, commands, and scheduled sync cycles.

import { Notice, Plugin, TAbstractFile, TFile, requestUrl, apiVersion, Platform } from "obsidian";
import { LocalDiagnostics, safeError } from "./diagnostics";
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
  private syncTimer: number | null = null;
  private startupTimer: number | null = null;
  private diagnostics: LocalDiagnostics | null = null;
  private diagnosticsConfiguration: Promise<void> = Promise.resolve();
  private unloading = false;
  private get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }
  private get syncExcludes(): string[] {
    return [...this.settings.excludes, this.app.vault.configDir];
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.configureDiagnostics();
    this.addCommand({id:"export-diagnostics", name:"Export local diagnostics", callback:() => this.exportDiagnostics()});

    // Initialize local index
    const storageAdapter: StorageAdapter = {
      read: async (path: string) => {
        const fullPath = `${this.pluginDir}/${path}`;
        const exists = await this.app.vault.adapter.exists(fullPath);
        if (!exists) return null;
        return await this.app.vault.adapter.read(fullPath);
      },
      write: async (path: string, data: string) => {
        const fullPath = `${this.pluginDir}/${path}`;
        const dir = this.pluginDir;
        if (!(await this.app.vault.adapter.exists(dir))) {
          await this.app.vault.adapter.mkdir(dir);
        }
        await this.app.vault.adapter.write(fullPath, data);
      },
    };

    this.index = new LocalIndex(storageAdapter, "state.json");
    try {
      await this.index.load();
    } catch (error) {
      await this.recordDiagnosticFailure("startup_failure", error);
      throw error;
    }

    this.setupEngine();

    // UI: Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatus("idle");
    this.statusBarItem.onClickEvent(() => {
      void this.triggerSync(true);
    });

    // UI: Ribbon Icon
    this.addRibbonIcon("refresh-cw", "Sync Vault", () => {
      void this.triggerSync(true);
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
          await this.recordDiagnosticFailure("status_failure", e);
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

    // Polling + startup sync are governed by autoSync and refreshed when
    // settings change (see saveSettings).
    this.setupAutoSync();
  }

  private setupEngine(): void {
    this.client = new SyncClient(
      this.settings.serverUrl,
      this.settings.token,
      this.settings.deviceName,
      async (params) => {
        try {
          const response = await requestUrl(params);
          if (response.status >= 400) this.diagnostics?.log("api_failure", {category:"api", status:response.status});
          return response;
        } catch (error) {
          this.diagnostics?.log("api_failure", safeError(error));
          throw error;
        }
      }
    );

    const vaultAdapter: VaultAdapter = {
      read: (path) => this.app.vault.adapter.read(path),
      readBinary: (path) => this.app.vault.adapter.readBinary(path),
      write: (path, text) => this.app.vault.adapter.write(path, text),
      writeBinary: (path, data) => this.app.vault.adapter.writeBinary(path, data),
      // Use the Vault API to notify Obsidian of new artifacts; the engine
      // separately reserves candidate names before awaiting filesystem I/O.
      createBinary: async (path, data) => {
        await this.app.vault.createBinary(path, data);
      },
      remove: (path) => this.app.vault.adapter.remove(path),
      rename: (from, to) => this.app.vault.adapter.rename(from, to),
      exists: (path) => this.app.vault.adapter.exists(path),
      mkdir: (path) => this.app.vault.adapter.mkdir(path),
      stat: async (path) => {
        const s = await this.app.vault.adapter.stat(path);
        return s ? { mtime: s.mtime, size: s.size } : null;
      },
      listFiles: async () => this.app.vault.getFiles().map((f) => f.path),
    };

    this.engine = new SyncEngine({
      adapter: vaultAdapter,
      index: this.index,
      client: this.client,
      deviceName: this.settings.deviceName,
      excludes: this.syncExcludes,
      onConflict: (orig, conflict) => {
        new Notice(`Sync conflict on ${orig}. Saved remote version to ${conflict}`, 8000);
        this.updateStatus("conflict");
      },
      onProgress: (current, total) => {
        this.updateStatus("syncing", `${current}/${total}`);
      },
    });
  }

  getClient(): SyncClient {
    return this.client;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.configureDiagnostics();
    this.setupEngine();
    this.setupAutoSync();
  }

  private setupAutoSync(): void {
    this.clearAutoSync();
    if (!this.settings.token || !this.settings.autoSync) return;

    this.syncTimer = window.setInterval(() => {
      if (this.settings.autoSync && this.settings.token) void this.triggerSync(false);
    }, Math.max(this.settings.syncIntervalSeconds, 5) * 1000);
    this.registerInterval(this.syncTimer);

    this.startupTimer = window.setTimeout(() => {
      this.startupTimer = null;
      void this.triggerSync(false);
    }, 1500);
    if (this.register) {
      this.register(() => {
        if (this.startupTimer !== null) {
          window.clearTimeout(this.startupTimer);
          this.startupTimer = null;
        }
      });
    }
  }

  private clearAutoSync(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.startupTimer !== null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  onunload(): Promise<void> {
    this.unloading = true;
    this.clearAutoSync();
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Obsidian may not await unload: abrupt process termination can lose this flush.
    return this.diagnostics?.close() ?? Promise.resolve();
  }

  private configureDiagnostics(): Promise<void> {
    const update = () => this.updateDiagnostics();
    this.diagnosticsConfiguration = this.diagnosticsConfiguration.then(update, update);
    return this.diagnosticsConfiguration;
  }

  private async updateDiagnostics(): Promise<void> {
    if (!this.settings.localDiagnostics || this.unloading) {
      await this.diagnostics?.close();
      this.diagnostics = null;
      return;
    }
    if (this.diagnostics) return;
    this.diagnostics = new LocalDiagnostics(this.app.vault.adapter, {
      pluginDir:this.pluginDir,
      pluginVersion:this.manifest?.version, obsidianVersion:apiVersion,
      platform:Platform?.isMobile ? "mobile" : Platform?.isDesktop ? "desktop" : "unknown",
      onFailure:() => { new Notice("Local sync diagnostics unavailable. Sync is unaffected; diagnostic export may be incomplete.", 8000); },
    });
    this.diagnostics.attachGlobalHandlers(window);
    await this.diagnostics.start();
  }

  async recordDiagnosticFailure(event: "startup_failure" | "status_failure" | "token_failure", error: unknown): Promise<void> {
    this.diagnostics?.log(event, safeError(error));
    await this.diagnostics?.flush();
  }

  async exportDiagnostics(): Promise<void> {
    if (!this.diagnostics) { new Notice("Local sync diagnostics are disabled. Enable them in settings before exporting."); return; }
    const result = await this.diagnostics.export();
    if (!result.path) new Notice("Diagnostic export failed: local storage unavailable.", 10000);
    else new Notice(`Diagnostic export${result.unavailable ? " incomplete (local storage unavailable)" : " saved"}: ${result.path}. Review before sharing; nothing was uploaded.`, 15000);
  }

  private updateStatus(status: "idle" | "syncing" | "conflict" | "error" | "pending", details?: string): void {
    if (!this.statusBarItem) return;
    switch (status) {
      case "syncing":
        this.statusBarItem.setText(details ? `🔄 Syncing (${details})...` : "🔄 Syncing...");
        break;
      case "conflict":
        this.statusBarItem.setText(details ? `⚠️ Sync conflict (${details})` : "⚠️ Sync conflict");
        break;
      case "pending":
        this.statusBarItem.setText(`⚠️ ${details ?? "Sync pending"}`);
        break;
      case "error":
        this.statusBarItem.setText(details ? `❌ Sync error (${details})` : "❌ Sync error");
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
    this.diagnostics?.log("sync_start");

    try {
      const res = await this.engine.sync();
      this.diagnostics?.log("sync_result", {pulled:res.pulled, pushed:res.pushed, conflicts:res.conflicts, failed:res.failed, pending:res.pending});
      for (const failure of res.errors) this.diagnostics?.log("sync_failure", {operation:failure.operation, category:"unknown"});
      if (res.failed > 0) {
        this.updateStatus("error", `${res.failed} failed`);
      } else if (res.conflicts > 0) {
        this.updateStatus("conflict");
      } else if (res.pending > 0) {
        this.updateStatus("pending", `${res.pending} pending`);
      } else {
        this.updateStatus("idle");
      }
      if (manual) {
        const parts = [`${res.pulled} pulled`, `${res.pushed} pushed`];
        if (res.conflicts > 0) parts.push(`${res.conflicts} conflicts`);
        if (res.failed > 0) parts.push(`${res.failed} failed`);
        if (res.pending > 0) parts.push(`${res.pending} pending`);
        new Notice(`Sync complete: ${parts.join(", ")}`);
      }
    } catch (e) {
      this.diagnostics?.log("sync_exception", safeError(e));
      this.updateStatus("error");
      if (manual) new Notice(`Sync failed: ${e}`);
    } finally {
      this.isSyncing = false;
      await this.diagnostics?.flush();
    }
  }

  private scheduleDebouncedSync(): void {
    if (!this.settings.autoSync) return;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.triggerSync(false);
    }, 2000);
  }

  private onFileCreated(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const path = normalizePath(file.path);
    if (isIgnored(path, this.syncExcludes)) return;
    const known = this.index.get(path);
    this.index.set(path, {
      ...known,
      base_rev: known?.base_rev ?? 0,
      base_hash: known?.base_hash ?? "",
      local_hash: "",
      mtime: Date.now(),
      dirty: true,
    });
    this.scheduleDebouncedSync();
  }

  private onFileModified(file: TAbstractFile): void {
    const path = normalizePath(file.path);
    if (isIgnored(path, this.syncExcludes)) return;
    const known = this.index.get(path);
    this.index.set(path, {
      ...known,
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
    if (isIgnored(path, this.syncExcludes)) return;
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
    if (isIgnored(oldNorm, this.syncExcludes) && isIgnored(newNorm, this.syncExcludes)) return;

    const paths = file instanceof TFile ? [oldNorm] : this.index.allEntries()
      .map(([path]) => path).filter((path) => path.startsWith(oldNorm + "/"));
    for (const oldFile of paths) {
      const newFile = newNorm + oldFile.slice(oldNorm.length);
      const known = this.index.get(oldFile);
      if (isIgnored(oldFile, this.syncExcludes)) continue;
      if (isIgnored(newFile, this.syncExcludes)) {
        // Moving into an excluded location is not a deletion of the remote
        // copy. Detach tracking instead of leaving a dirty old path, which
        // would otherwise be pushed as a server-side delete.
        if (known) this.index.remove(oldFile);
        continue;
      }
      if (known && known.base_rev > 0) {
        this.index.queueRename({ from: oldFile, to: newFile, base_rev: known.base_rev });
        this.index.set(newFile, { ...known, dirty: known.dirty ?? false });
        this.index.remove(oldFile);
      } else if (file instanceof TFile) {
        this.onFileCreated(file);
      }
    }
    if (isIgnored(oldNorm, this.syncExcludes) && file instanceof TFile) this.onFileCreated(file);
    this.scheduleDebouncedSync();
  }
}
