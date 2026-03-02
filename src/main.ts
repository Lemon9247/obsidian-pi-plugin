import { Notice, Plugin } from "obsidian";
import { PiConnection } from "./rpc";
import { DEFAULT_SETTINGS, PiSettingTab } from "./settings";
import type { PiPluginSettings } from "./settings";

export default class PiPlugin extends Plugin {
    settings: PiPluginSettings = DEFAULT_SETTINGS;
    connection: PiConnection | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.addSettingTab(new PiSettingTab(this.app, this));

        this.addCommand({
            id: "pi-send-prompt",
            name: "Send prompt",
            callback: () => this.sendTestPrompt(),
        });

        console.log("[Pi Plugin] Loaded");
    }

    onunload(): void {
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }
        console.log("[Pi Plugin] Unloaded");
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /**
     * Get or create a PiConnection using current settings.
     */
    private ensureConnection(): PiConnection {
        if (this.connection && this.connection.isConnected()) {
            return this.connection;
        }

        // Determine working directory: setting or vault root
        const vaultRoot = (this.app.vault.adapter as { getBasePath?(): string }).getBasePath?.() ?? ".";
        const cwd = this.settings.workingDirectory || vaultRoot;

        this.connection = new PiConnection(this.settings.piBinaryPath, cwd);

        this.connection.onEvent((event) => {
            console.log("[Pi RPC] Event:", event);
        });

        this.connection.connect();
        return this.connection;
    }

    /**
     * Send a test prompt to Pi and log all received events.
     */
    private sendTestPrompt(): void {
        try {
            const conn = this.ensureConnection();

            new Notice("Sending prompt to Pi...");

            conn.send({
                type: "prompt",
                content: "Hello from Obsidian!",
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Pi error: ${msg}`);
            console.error("[Pi Plugin] Error sending prompt:", err);
        }
    }
}
