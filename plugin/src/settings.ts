// Obsidian settings tab and configuration definitions.

import { App, PluginSettingTab, Setting } from "obsidian";
import type DistributedSyncPlugin from "./main";

export interface DistributedSyncSettings {
  serverUrl: string;
  token: string;
  deviceName: string;
  autoSync: boolean;
  syncIntervalSeconds: number;
  excludes: string[];
}

export const DEFAULT_SETTINGS: DistributedSyncSettings = {
  serverUrl: "http://localhost:8787",
  token: "",
  deviceName: "Desktop",
  autoSync: true,
  syncIntervalSeconds: 30,
  excludes: [".obsidian", ".trash", ".git"],
};

export class DistributedSyncSettingTab extends PluginSettingTab {
  plugin: DistributedSyncPlugin;

  constructor(app: App, plugin: DistributedSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Distributed Sync Settings" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The URL of your Cloudflare Worker sync server (e.g., https://sync.example.workers.dev)")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8787")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (val) => {
            this.plugin.settings.serverUrl = val.trim().replace(/\s+/g, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device Token")
      .setDesc("Bearer authentication token for this device")
      .addText((text) =>
        text
          .setPlaceholder("obs_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (val) => {
            this.plugin.settings.token = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device Name")
      .setDesc("Name used to identify this device in conflict copies and logs")
      .addText((text) =>
        text
          .setPlaceholder("Laptop")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (val) => {
            this.plugin.settings.deviceName = val.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto Sync")
      .setDesc("Automatically sync changes in background when editing notes")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (val) => {
            this.plugin.settings.autoSync = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync Interval (seconds)")
      .setDesc("How often to check for remote updates in background")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.syncIntervalSeconds))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 5) {
              this.plugin.settings.syncIntervalSeconds = num;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
