import { FuzzySuggestModal, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { PiConnection } from "./rpc";
import { DEFAULT_SETTINGS, PiSettingTab } from "./settings";
import type { PiPluginSettings } from "./settings";
import { PiChatView, VIEW_TYPE_PI_CHAT } from "./view";
import { SessionManager } from "./sessions";
import { SessionListModal, buildSessionEntries } from "./session-list";
import { PiStatusBar } from "./statusbar";
import { CommandSuggest } from "./commands";
import type { PiCommand } from "./commands";
import { MessageStore } from "./message-store";
import type { MessageStoreData } from "./message-store";

interface ModelOption {
    id: string;
    name: string;
    provider: string;
}

/**
 * Modal for selecting a model from Pi's available models.
 */
class ModelSwitchModal extends FuzzySuggestModal<ModelOption> {
    private models: ModelOption[];
    private onSelect: (model: ModelOption) => void;

    constructor(app: import("obsidian").App, models: ModelOption[], onSelect: (model: ModelOption) => void) {
        super(app);
        this.models = models;
        this.onSelect = onSelect;
        this.setPlaceholder("Select a model...");
    }

    getItems(): ModelOption[] {
        return this.models;
    }

    getItemText(item: ModelOption): string {
        return `${item.name} (${item.provider})`;
    }

    onChooseItem(item: ModelOption): void {
        this.onSelect(item);
    }
}

export default class PiPlugin extends Plugin {
    settings: PiPluginSettings = DEFAULT_SETTINGS;
    connection: PiConnection | null = null;
    sessionManager: SessionManager = new SessionManager();
    messageStore: MessageStore = new MessageStore();
    statusBar: PiStatusBar | null = null;
    private commandSuggest: CommandSuggest | null = null;
    /** IDs of dynamically registered Pi commands (for cleanup on re-registration) */
    private dynamicCommandIds: string[] = [];
    /** Debounce timer for message store persistence */
    private storeFlushTimer: ReturnType<typeof setTimeout> | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();
        await this.loadMessageStore();

        this.addSettingTab(new PiSettingTab(this.app, this));

        // Register the chat view
        this.registerView(
            VIEW_TYPE_PI_CHAT,
            (leaf: WorkspaceLeaf) => new PiChatView(leaf, this),
        );

        // Ribbon icon to open chat
        this.addRibbonIcon("message-circle", "Open Pi Chat", () => {
            this.activateView();
        });

        // Command: open chat view
        this.addCommand({
            id: "pi-open-chat",
            name: "Open chat",
            callback: () => this.activateView(),
        });

        this.addCommand({
            id: "pi-send-prompt",
            name: "Send prompt",
            callback: () => this.sendTestPrompt(),
        });

        // Session management commands
        this.addCommand({
            id: "pi-save-session",
            name: "Save conversation",
            callback: () => this.saveCurrentSession(),
        });

        this.addCommand({
            id: "pi-browse-sessions",
            name: "Browse sessions",
            callback: () => this.browseSessions(),
        });

        this.addCommand({
            id: "pi-new-session",
            name: "New session",
            callback: () => this.newSession(),
        });

        // Model switcher
        this.addCommand({
            id: "pi-switch-model",
            name: "Switch model",
            callback: () => this.switchModel(),
        });

        // Status bar
        const statusBarEl = this.addStatusBarItem();
        this.statusBar = new PiStatusBar(this, statusBarEl);

        // TODO P4-T6: Fork from previous message
        // Requires tracking Pi's internal entry IDs from agent_end events.
        // The piEntryId field is on ChatMessage but not yet populated.
        // Implement when entry ID tracking is wired up in stream-handler.

        console.log("[Pi Plugin] Loaded");
    }

    async onunload(): Promise<void> {
        // Auto-save conversation before unloading
        const view = this.getActiveView();
        if (view && view.hasMessages()) {
            try {
                await view.autoSave();
            } catch (err) {
                console.error("[Pi Plugin] Failed to save session on unload:", err);
            }
        }

        // Flush message store
        await this.flushMessageStore();
        if (this.storeFlushTimer) {
            clearTimeout(this.storeFlushTimer);
            this.storeFlushTimer = null;
        }

        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }
        console.log("[Pi Plugin] Unloaded");
    }

    /**
     * Find or create the Pi Chat view as a tab in the main editor area.
     */
    async activateView(): Promise<PiChatView> {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT);

        if (leaves.length > 0) {
            // View already exists — reveal it
            leaf = leaves[0];
        } else {
            // Open as a new tab in the main editor area
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({
                type: VIEW_TYPE_PI_CHAT,
                active: true,
            });
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }

        return this.getActiveView()!;
    }

    /**
     * Get the currently active PiChatView, if any.
     */
    getActiveView(): PiChatView | null {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT);
        if (leaves.length === 0) return null;
        const view = leaves[0].view;
        if (view instanceof PiChatView) return view;
        return null;
    }

    /**
     * Save the current conversation to a vault note.
     */
    private async saveCurrentSession(): Promise<void> {
        const view = this.getActiveView();
        if (!view) {
            new Notice("No active Pi chat");
            return;
        }
        if (!view.hasMessages()) {
            new Notice("No conversation to save");
            return;
        }

        try {
            const path = await view.autoSave();
            if (path) {
                new Notice(`Session saved to ${path}`);
            } else {
                new Notice("Session not saved (persistence disabled or empty)");
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to save session: ${msg}`);
        }
    }

    /**
     * Open the session browser modal to load a previous conversation.
     */
    private async browseSessions(): Promise<void> {
        const entries = await buildSessionEntries(
            this.app,
            this.settings.sessionSaveDir,
        );

        if (entries.length === 0) {
            new Notice("No saved sessions found");
            return;
        }

        const modal = new SessionListModal(
            this.app,
            entries,
            async (entry) => {
                try {
                    const messages = await this.sessionManager.loadSession(
                        entry.file.path,
                        this.app.vault,
                    );
                    const view = await this.activateView();
                    view.displayMessages(messages, true);
                    new Notice(`Loaded session: ${entry.date}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    new Notice(`Failed to load session: ${msg}`);
                    console.error("[Pi Plugin] Load session error:", err);
                }
            },
        );
        modal.open();
    }

    /**
     * Start a new session — delegates to the view's newSession flow.
     */
    private async newSession(): Promise<void> {
        const view = await this.activateView();
        view.startNewSession();
    }

    /**
     * Fetch Pi's commands and register them in Obsidian's command palette.
     * Re-registers on each call (commands may differ per project/connection).
     */
    async registerPiCommands(): Promise<void> {
        // Initialize CommandSuggest if needed
        if (!this.commandSuggest) {
            this.commandSuggest = new CommandSuggest(this.app);
        }
        if (this.connection) {
            this.commandSuggest.setConnection(this.connection);
        }

        // Remove previously registered dynamic commands
        // Obsidian doesn't have removeCommand(), but we can re-register with same IDs
        // which effectively updates them. We just need to track IDs.

        let commands: PiCommand[];
        try {
            commands = await this.commandSuggest.getCommands();
        } catch {
            return;
        }

        const newIds: string[] = [];

        for (const cmd of commands) {
            const id = `pi-cmd-${cmd.name}`;
            newIds.push(id);

            // Only register if not already registered
            if (!this.dynamicCommandIds.includes(id)) {
                this.addCommand({
                    id,
                    name: `Pi: /${cmd.name}${cmd.description ? ` — ${cmd.description}` : ""}`,
                    callback: () => {
                        this.sendPiCommand(cmd.name);
                    },
                });
            }
        }

        this.dynamicCommandIds = newIds;
    }

    /**
     * Send a Pi command by activating the chat view and sending the command as a prompt.
     */
    private async sendPiCommand(commandName: string): Promise<void> {
        const view = await this.activateView();
        view.sendMessage(`/${commandName}`);
    }

    /**
     * Load message store from plugin data.
     */
    private async loadMessageStore(): Promise<void> {
        try {
            const raw = await this.loadData();
            const storeData = raw?.messageStore as MessageStoreData | undefined;
            this.messageStore.load(storeData || null);
        } catch {
            // Non-fatal
        }
    }

    /**
     * Persist message store to plugin data (debounced).
     */
    scheduleStoreFlush(): void {
        if (this.storeFlushTimer) return;
        this.storeFlushTimer = setTimeout(() => {
            this.storeFlushTimer = null;
            this.flushMessageStore();
        }, 2000);
    }

    /**
     * Immediately persist message store.
     */
    async flushMessageStore(): Promise<void> {
        if (!this.messageStore.isDirty()) return;
        try {
            const existing = (await this.loadData()) || {};
            existing.messageStore = this.messageStore.serialize();
            await this.saveData(existing);
        } catch (err) {
            console.error("[Pi Plugin] Failed to flush message store:", err);
        }
    }

    async loadSettings(): Promise<void> {
        const raw = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /**
     * Get or create a PiConnection using current settings.
     */
    ensureConnection(): PiConnection {
        if (this.connection && this.connection.isConnected()) {
            return this.connection;
        }

        // Destroy old dead connection if it exists
        if (this.connection) {
            this.connection.destroy();
            this.connection = null;
        }

        // Determine working directory: setting or vault root
        const adapter = this.app.vault.adapter;
        if (!('getBasePath' in adapter) || typeof (adapter as any).getBasePath !== 'function') {
            new Notice("Cannot determine vault path (mobile not supported)");
            throw new Error("Vault adapter does not support getBasePath");
        }
        const vaultRoot = (adapter as any).getBasePath();
        const cwd = this.settings.workingDirectory || vaultRoot;

        const args: string[] = [];
        if (this.settings.defaultProvider) {
            args.push("--provider", this.settings.defaultProvider);
        }
        if (this.settings.defaultModel) {
            args.push("--model", this.settings.defaultModel);
        }

        this.connection = new PiConnection(this.settings.piBinaryPath, cwd, args);

        this.connection.onEvent((event) => {
            // Update status bar on streaming state changes
            const type = event.type as string;
            if (type === "agent_start") {
                this.statusBar?.setStreaming(true);
            } else if (type === "agent_end") {
                this.statusBar?.setStreaming(false);
                this.statusBar?.refreshStats();
            } else if (type === "auto_compaction_end") {
                new Notice("Pi conversation compacted");
            }
        });

        this.connection.onDisconnect(() => {
            const view = this.getActiveView();
            if (view) {
                view.handleDisconnect();
            }
            new Notice("Pi disconnected. Use 'Pi: Send prompt' to reconnect.");
            this.connection = null;
        });

        this.connection.connect();

        // Refresh status bar and register commands once connected
        // Use a short delay to let Pi initialize
        setTimeout(() => {
            this.statusBar?.refreshModel();
            this.statusBar?.refreshStats();
            this.registerPiCommands();
        }, 1000);

        return this.connection;
    }

    /**
     * Open modal to switch Pi's active model.
     */
    private async switchModel(): Promise<void> {
        try {
            const conn = this.ensureConnection();
            const response = await conn.send({ type: "get_available_models" });
            const data = response.data as Record<string, unknown> | undefined;
            const models = (data?.models as Array<Record<string, unknown>>) ?? [];

            if (models.length === 0) {
                new Notice("No models available");
                return;
            }

            const options: ModelOption[] = models.map((m) => ({
                id: (m.id as string) ?? "",
                name: (m.name as string) ?? (m.id as string) ?? "Unknown",
                provider: (m.provider as string) ?? "",
            })).filter((m) => m.id);

            const modal = new ModelSwitchModal(this.app, options, async (selected) => {
                try {
                    await conn.send({
                        type: "set_model",
                        provider: selected.provider,
                        modelId: selected.id,
                    });
                    new Notice(`Switched to ${selected.name}`);
                    this.statusBar?.setModel(selected.name, "");
                    this.statusBar?.refreshModel();
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    new Notice(`Failed to switch model: ${msg}`);
                }
            });
            modal.open();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Failed to fetch models: ${msg}`);
        }
    }

    /**
     * Send a test prompt to Pi and log all received events.
     */
    private async sendTestPrompt(): Promise<void> {
        try {
            const conn = this.ensureConnection();

            new Notice("Sending prompt to Pi...");

            await conn.send({
                type: "prompt",
                message: "Hello from Obsidian!",
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Pi error: ${msg}`);
            console.error("[Pi Plugin] Error sending prompt:", err);
        }
    }
}
