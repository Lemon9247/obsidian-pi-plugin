import { App, PluginSettingTab, Setting } from "obsidian";
import type PiPlugin from "./main";

export interface PiPluginSettings {
    piBinaryPath: string;
    workingDirectory: string;
    defaultProvider: string;
    defaultModel: string;
    sessionSaveDir: string;
    persistSessions: boolean;
    thinkingLevel: string;
}

export const DEFAULT_SETTINGS: PiPluginSettings = {
    piBinaryPath: "/home/lemoneater/.local/bin/pi",
    workingDirectory: "",  // empty = vault root
    defaultProvider: "",
    defaultModel: "",
    sessionSaveDir: "Pi-Sessions",
    persistSessions: true,
    thinkingLevel: "medium",
};

export class PiSettingTab extends PluginSettingTab {
    plugin: PiPlugin;

    constructor(app: App, plugin: PiPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Pi Plugin Settings" });

        new Setting(containerEl)
            .setName("Pi binary path")
            .setDesc("Path to the pi executable (default: pi)")
            .addText((text) =>
                text
                    .setPlaceholder("pi")
                    .setValue(this.plugin.settings.piBinaryPath)
                    .onChange(async (value) => {
                        this.plugin.settings.piBinaryPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Working directory")
            .setDesc("Working directory for Pi (empty = vault root)")
            .addText((text) =>
                text
                    .setPlaceholder("Leave empty for vault root")
                    .setValue(this.plugin.settings.workingDirectory)
                    .onChange(async (value) => {
                        this.plugin.settings.workingDirectory = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Default provider")
            .setDesc("Default LLM provider (e.g. anthropic, openai)")
            .addText((text) =>
                text
                    .setPlaceholder("Leave empty for Pi default")
                    .setValue(this.plugin.settings.defaultProvider)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultProvider = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Default model")
            .setDesc("Default model name (e.g. claude-sonnet-4)")
            .addText((text) =>
                text
                    .setPlaceholder("Leave empty for Pi default")
                    .setValue(this.plugin.settings.defaultModel)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultModel = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Session save directory")
            .setDesc("Vault directory for saved conversations")
            .addText((text) =>
                text
                    .setPlaceholder("Pi-Sessions")
                    .setValue(this.plugin.settings.sessionSaveDir)
                    .onChange(async (value) => {
                        this.plugin.settings.sessionSaveDir = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Persist sessions")
            .setDesc("Automatically save conversations as vault notes")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.persistSessions)
                    .onChange(async (value) => {
                        this.plugin.settings.persistSessions = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Thinking level")
            .setDesc("Level of thinking/reasoning for the model")
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("none", "None")
                    .addOption("low", "Low")
                    .addOption("medium", "Medium")
                    .addOption("high", "High")
                    .setValue(this.plugin.settings.thinkingLevel)
                    .onChange(async (value) => {
                        this.plugin.settings.thinkingLevel = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
