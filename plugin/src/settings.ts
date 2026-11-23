// Obsidian settings tab and configuration definitions.

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DistributedSyncPlugin from "./main";

export interface DistributedSyncSettings {
  serverUrl: string;
  token: string;
  deviceName: string;
  autoSync: boolean;
  syncIntervalSeconds: number;
  excludes: string[];
  localDiagnostics: boolean;
}

export const DEFAULT_SETTINGS: DistributedSyncSettings = {
  serverUrl: "http://localhost:8787",
  token: "",
  deviceName: "Desktop",
  autoSync: true,
  syncIntervalSeconds: 30,
  excludes: [".obsidian", ".trash", ".git"],
  localDiagnostics: true,
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
      .setName("Device token")
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
      .setName("Device name")
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
      .setName("Auto sync")
      .setDesc("Automatically sync changes in the background when editing notes")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async (val) => {
            this.plugin.settings.autoSync = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (seconds)")
      .setDesc("How often to check for remote updates in the background")
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

    new Setting(containerEl).setName("Diagnostics").setHeading();
    new Setting(containerEl)
      .setName("Local diagnostics")
      .setDesc("Bounded local-only troubleshooting logs; no note content, paths, credentials, or uploads. Disabling retains existing logs.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.localDiagnostics).onChange(async value => {
        this.plugin.settings.localDiagnostics = value;
        await this.plugin.saveSettings();
      }))
      .addButton(button => button.setButtonText("Export diagnostics").onClick(() => this.plugin.exportDiagnostics()));

    new Setting(containerEl).setName("Add another device").setHeading();
    let newDeviceName = "Tablet";
    new Setting(containerEl)
      .setName("New device name")
      .setDesc("Generate an authenticated token for your phone, tablet, or another computer")
      .addText((text) =>
        text
          .setPlaceholder("Tablet")
          .setValue(newDeviceName)
          .onChange((val) => {
            newDeviceName = val.trim();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Generate token")
          .setCta()
          .onClick(async () => {
            if (!this.plugin.settings.token) {
              new Notice("Cannot mint token: this device is not connected yet.");
              return;
            }
            try {
              btn.setDisabled(true);
              const res = await this.plugin.getClient().issueToken(newDeviceName || "NewDevice");
              await navigator.clipboard.writeText(res.token);
              new Notice(`Token for "${newDeviceName}" generated and copied to clipboard! Paste it on your other device.`, 12000);
            } catch (e) {
              await this.plugin.recordDiagnosticFailure("token_failure", e);
              new Notice(`Failed to generate token: ${e}`);
            } finally {
              btn.setDisabled(false);
            }
          })
      );
  }
}
