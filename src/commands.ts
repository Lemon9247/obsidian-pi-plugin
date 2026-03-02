/**
 * Command suggest for `/` prefix in the chat input.
 *
 * When the user types `/` as the first character, fetches available commands
 * from Pi via `get_commands` RPC and shows a FuzzySuggestModal. On selection,
 * replaces the input text with the selected command.
 */

import { App, FuzzySuggestModal } from "obsidian";
import type { PiConnection } from "./rpc";

interface PiCommand {
    name: string;
    description: string;
}

/**
 * Modal that shows available Pi commands with fuzzy search.
 */
class CommandSuggestModal extends FuzzySuggestModal<PiCommand> {
    private commands: PiCommand[];
    private onSelect: (cmd: PiCommand) => void;

    constructor(app: App, commands: PiCommand[], onSelect: (cmd: PiCommand) => void) {
        super(app);
        this.commands = commands;
        this.onSelect = onSelect;
        this.setPlaceholder("Select a command...");
    }

    getItems(): PiCommand[] {
        return this.commands;
    }

    getItemText(item: PiCommand): string {
        return `/${item.name}`;
    }

    onChooseItem(item: PiCommand, _evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item);
    }

    renderSuggestion(item: { item: PiCommand; match: { score: number; matches: any[] } }, el: HTMLElement): void {
        const wrapper = el.createDiv({ cls: "pi-command-suggest-item" });
        wrapper.createDiv({ text: `/${item.item.name}`, cls: "pi-command-name" });
        if (item.item.description) {
            wrapper.createDiv({ text: item.item.description, cls: "pi-command-desc" });
        }
    }
}

export class CommandSuggest {
    private app: App;
    private connection: PiConnection | null = null;
    private cachedCommands: PiCommand[] | null = null;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Set the RPC connection used to fetch commands.
     */
    setConnection(connection: PiConnection): void {
        this.connection = connection;
        // Invalidate cache on new connection
        this.cachedCommands = null;
    }

    /**
     * Trigger the command suggest modal. Fetches commands from Pi and shows the picker.
     * On selection, calls the callback with the full command string (e.g. "/plan ").
     */
    async trigger(onSelect: (commandText: string) => void): Promise<void> {
        const commands = await this.fetchCommands();
        if (commands.length === 0) {
            return;
        }

        const modal = new CommandSuggestModal(
            this.app,
            commands,
            (cmd) => {
                onSelect(`/${cmd.name} `);
            },
        );
        modal.open();
    }

    /**
     * Fetch commands from Pi. Uses cached list if available.
     * Cache is invalidated on each trigger to stay fresh.
     */
    private async fetchCommands(): Promise<PiCommand[]> {
        if (!this.connection || !this.connection.isConnected()) {
            return this.getFallbackCommands();
        }

        try {
            const response = await this.connection.send({ type: "get_commands" });
            const commands = response.commands as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(commands)) {
                this.cachedCommands = commands.map((cmd) => ({
                    name: String(cmd.name || ""),
                    description: String(cmd.description || ""),
                }));
                return this.cachedCommands;
            }
        } catch (err) {
            console.warn("[Pi Commands] Failed to fetch commands:", err);
        }

        // Fall back to cached or static list
        if (this.cachedCommands) {
            return this.cachedCommands;
        }
        return this.getFallbackCommands();
    }

    /**
     * Static fallback commands in case RPC fails.
     */
    private getFallbackCommands(): PiCommand[] {
        return [
            { name: "plan", description: "Create an implementation plan" },
            { name: "report", description: "Write a session report" },
            { name: "catchup", description: "Verify project state" },
            { name: "loop", description: "Execute plan-implement-review cycle" },
            { name: "swarm", description: "Multi-agent task execution" },
            { name: "search", description: "Search the web" },
        ];
    }
}
