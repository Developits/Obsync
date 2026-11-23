// Obsidian settings tab and configuration definitions.

import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionRender } from "obsidian";
import type DistributedSyncPlugin from "./main";
import { isRecord, isUnknownArray, errorMessage } from "./validation";

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
  excludes: [".trash", ".git"],
  localDiagnostics: true,
};

export function parseSettings(value: unknown): DistributedSyncSettings {
  const defaults = {...DEFAULT_SETTINGS, excludes:[...DEFAULT_SETTINGS.excludes]};
  if (!isRecord(value)) return defaults;
  return {
    serverUrl:typeof value.serverUrl === "string" ? value.serverUrl : defaults.serverUrl,
    token:typeof value.token === "string" ? value.token : defaults.token,
    deviceName:typeof value.deviceName === "string" ? value.deviceName : defaults.deviceName,
    autoSync:typeof value.autoSync === "boolean" ? value.autoSync : defaults.autoSync,
    syncIntervalSeconds:typeof value.syncIntervalSeconds === "number"
      && Number.isSafeInteger(value.syncIntervalSeconds) && value.syncIntervalSeconds >= 5
      && value.syncIntervalSeconds <= 2147483 ? value.syncIntervalSeconds : defaults.syncIntervalSeconds,
    excludes:isUnknownArray(value.excludes) && value.excludes.every((entry): entry is string => typeof entry === "string")
      ? [...value.excludes] : defaults.excludes,
    localDiagnostics:typeof value.localDiagnostics === "boolean" ? value.localDiagnostics : defaults.localDiagnostics,
  };
}

// These rows do not need a SettingGroup, so the legacy renderer can call them
// without constructing the newer host's group API.
type SearchableSetting = Omit<SettingDefinitionRender, "render"> & {
  render: (setting: Setting) => void;
};

export class DistributedSyncSettingTab extends PluginSettingTab {
  plugin: DistributedSyncPlugin;

  constructor(app: App, plugin: DistributedSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    // Compatibility renderer for hosts before the declarative API (1.13).
    // New hosts render/index these same definitions for settings search.
    this.containerEl.empty();
    for (const definition of this.getSettingDefinitions()) {
      const setting = new Setting(this.containerEl).setName(definition.name);
      if (definition.desc) setting.setDesc(definition.desc);
      definition.render(setting);
    }
  }

  getSettingDefinitions(): SearchableSetting[] {
    let newDeviceName = "Tablet";
    return [
      {
        name: "Server URL",
        desc: "The URL of your Cloudflare Worker sync server (e.g., https://sync.example.workers.dev)",
        render: (setting) => {
          setting.addText((text) =>
            text.setPlaceholder("http://localhost:8787")
              .setValue(this.plugin.settings.serverUrl)
              .onChange(async (val) => {
                this.plugin.settings.serverUrl = val.trim().replace(/\s+/g, "");
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Device token",
        desc: "Bearer authentication token for this device",
        render: (setting) => {
          setting.addText((text) =>
            text.setPlaceholder("obs_...")
              .setValue(this.plugin.settings.token)
              .onChange(async (val) => {
                this.plugin.settings.token = val.trim();
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Device name",
        desc: "Name used to identify this device in conflict copies and logs",
        render: (setting) => {
          setting.addText((text) =>
            text.setPlaceholder("Laptop")
              .setValue(this.plugin.settings.deviceName)
              .onChange(async (val) => {
                this.plugin.settings.deviceName = val.trim();
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Auto sync",
        desc: "Automatically sync changes in the background when editing notes",
        render: (setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.autoSync)
              .onChange(async (val) => {
                this.plugin.settings.autoSync = val;
                await this.plugin.saveSettings();
              })
          );
        },
      },
      {
        name: "Sync interval (seconds)",
        desc: "How often to check for remote updates in the background",
        render: (setting) => {
          setting.addText((text) =>
            text.setPlaceholder("30")
              .setValue(String(this.plugin.settings.syncIntervalSeconds))
              .onChange(async (val) => {
                const num = Number(val);
                if (Number.isSafeInteger(num) && num >= 5 && num <= 2147483) {
                  this.plugin.settings.syncIntervalSeconds = num;
                  await this.plugin.saveSettings();
                }
              })
          );
        },
      },
      {
        name: "Local diagnostics",
        desc: "Bounded local-only troubleshooting logs; no note content, paths, credentials, or uploads. Disabling retains existing logs.",
        render: (setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.localDiagnostics).onChange(async (value) => {
              this.plugin.settings.localDiagnostics = value;
              await this.plugin.saveSettings();
            })
          ).addButton((button) =>
            button.setButtonText("Export diagnostics").onClick(() => this.plugin.exportDiagnostics())
          );
        },
      },
      {
        name: "New device name",
        desc: "Generate an authenticated token for your phone, tablet, or another computer",
        render: (setting) => {
          setting.addText((text) =>
            text.setPlaceholder("Tablet").setValue(newDeviceName).onChange((val) => {
              newDeviceName = val.trim();
            })
          ).addButton((btn) =>
            btn.setButtonText("Generate token").setCta().onClick(async () => {
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
                new Notice(`Failed to generate token: ${errorMessage(e)}`);
              } finally {
                btn.setDisabled(false);
              }
            })
          );
        },
      },
    ];
  }
}
