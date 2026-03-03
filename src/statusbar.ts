import type PiPlugin from "./main";

/**
 * Manages the status bar item showing Pi connection state,
 * model info, and token/cost stats.
 */
export class PiStatusBar {
    private plugin: PiPlugin;
    private statusBarEl: HTMLElement;
    private model = "";
    private thinkingLevel = "";
    private streaming = false;
    private tokens = 0;
    private cost = 0;

    constructor(plugin: PiPlugin, statusBarEl: HTMLElement) {
        this.plugin = plugin;
        this.statusBarEl = statusBarEl;
        this.statusBarEl.addClass("pi-status-bar");
        this.render();
    }

    setModel(model: string, thinkingLevel: string): void {
        this.model = model;
        this.thinkingLevel = thinkingLevel;
        this.render();
    }

    setStreaming(streaming: boolean): void {
        this.streaming = streaming;
        this.render();
    }

    setStats(tokens: number, cost: number): void {
        this.tokens = tokens;
        this.cost = cost;
        this.render();
    }

    /**
     * Fetch current stats from Pi via RPC and update display.
     */
    async refreshStats(): Promise<void> {
        if (!this.plugin.connection?.isConnected()) return;

        try {
            const response = await this.plugin.connection.send({
                type: "get_session_stats",
            });
            const data = response.data as Record<string, unknown> | undefined;
            if (data) {
                const tokens = data.tokens as Record<string, unknown> | undefined;
                this.tokens = (tokens?.total as number) ?? 0;
                this.cost = (data.cost as number) ?? 0;
                this.render();
            }
        } catch {
            // Non-fatal — stats are informational
        }
    }

    /**
     * Fetch current model info from Pi via RPC.
     */
    async refreshModel(): Promise<void> {
        if (!this.plugin.connection?.isConnected()) return;

        try {
            const response = await this.plugin.connection.send({
                type: "get_state",
            });
            const data = response.data as Record<string, unknown> | undefined;
            if (data) {
                const model = data.model as Record<string, unknown> | undefined;
                this.model = (model?.name as string) ?? "";
                this.thinkingLevel = (data.thinkingLevel as string) ?? "";
                this.render();
            }
        } catch {
            // Non-fatal
        }
    }

    private render(): void {
        const parts: string[] = [];

        if (this.model) {
            let modelText = this.model;
            if (this.thinkingLevel && this.thinkingLevel !== "off") {
                modelText += ` :${this.thinkingLevel}`;
            }
            parts.push(modelText);
        } else {
            parts.push("Pi");
        }

        if (this.streaming) {
            parts.push("⏳");
        }

        if (this.tokens > 0) {
            const tokenStr = this.tokens > 1000
                ? `${(this.tokens / 1000).toFixed(1)}k`
                : String(this.tokens);
            parts.push(tokenStr);
        }

        if (this.cost > 0) {
            parts.push(`$${this.cost.toFixed(2)}`);
        }

        this.statusBarEl.setText(parts.join(" · "));
    }
}
