/**
 * Session panel — collapsible sidebar within the chat view.
 *
 * Shows a list of Pi's native sessions (from ~/.pi/agent/sessions/),
 * with actions to switch, delete, and export. Search/filter supported.
 */

import { Notice } from "obsidian";
import { SessionScanner } from "./session-scanner";
import type { PiSession } from "./session-scanner";

export interface SessionPanelCallbacks {
    /** Switch to the selected session */
    onSwitch: (session: PiSession) => Promise<void>;
    /** Delete a session */
    onDelete: (session: PiSession) => Promise<void>;
    /** Export session to vault as markdown */
    onExport: (session: PiSession) => Promise<void>;
}

export class SessionPanel {
    private containerEl: HTMLElement;
    private listEl: HTMLElement;
    private searchEl: HTMLInputElement;
    private scanner: SessionScanner;
    private callbacks: SessionPanelCallbacks;
    private sessions: PiSession[] = [];
    private visible = false;
    private currentSessionPath: string | null = null;

    constructor(
        parentEl: HTMLElement,
        callbacks: SessionPanelCallbacks,
        sessionsDir?: string,
    ) {
        this.callbacks = callbacks;
        this.scanner = new SessionScanner(sessionsDir);

        // Panel container — hidden by default
        this.containerEl = parentEl.createDiv({ cls: "pi-session-panel" });
        this.containerEl.style.display = "none";

        // Panel header
        const header = this.containerEl.createDiv({ cls: "pi-session-panel-header" });
        header.createSpan({ text: "Sessions", cls: "pi-session-panel-title" });

        const closeBtn = header.createEl("button", {
            cls: "pi-session-panel-close",
            attr: { "aria-label": "Close panel" },
        });
        closeBtn.setText("×");
        closeBtn.addEventListener("click", () => this.hide());

        // Search input
        this.searchEl = this.containerEl.createEl("input", {
            cls: "pi-session-panel-search",
            attr: { type: "text", placeholder: "Filter sessions…" },
        });
        this.searchEl.addEventListener("input", () => this.renderList());

        // Session list
        this.listEl = this.containerEl.createDiv({ cls: "pi-session-panel-list" });
    }

    /**
     * Toggle panel visibility.
     */
    toggle(): void {
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * Show the panel and refresh session list.
     */
    async show(): Promise<void> {
        this.visible = true;
        this.containerEl.style.display = "";
        await this.refresh();
        this.searchEl.focus();
    }

    /**
     * Hide the panel.
     */
    hide(): void {
        this.visible = false;
        this.containerEl.style.display = "none";
    }

    /**
     * Check if the panel is visible.
     */
    isVisible(): boolean {
        return this.visible;
    }

    /**
     * Set the current active session path (highlights it in the list).
     */
    setCurrentSession(path: string | null): void {
        this.currentSessionPath = path;
        if (this.visible) {
            this.renderList();
        }
    }

    /**
     * Refresh the session list from disk.
     */
    async refresh(): Promise<void> {
        try {
            this.sessions = await this.scanner.scan();
            this.renderList();
        } catch (err) {
            console.error("[SessionPanel] Failed to scan sessions:", err);
            this.listEl.empty();
            this.listEl.createDiv({
                cls: "pi-session-panel-empty",
                text: "Failed to load sessions",
            });
        }
    }

    /**
     * Clean up the panel.
     */
    destroy(): void {
        this.containerEl.remove();
    }

    // --- Private ---

    private renderList(): void {
        this.listEl.empty();

        const filter = this.searchEl.value.trim().toLowerCase();
        const filtered = filter
            ? this.sessions.filter(
                (s) =>
                    s.name.toLowerCase().includes(filter) ||
                    s.preview.toLowerCase().includes(filter) ||
                    s.cwd.toLowerCase().includes(filter),
            )
            : this.sessions;

        if (filtered.length === 0) {
            this.listEl.createDiv({
                cls: "pi-session-panel-empty",
                text: this.sessions.length === 0
                    ? "No sessions found"
                    : "No matching sessions",
            });
            return;
        }

        for (const session of filtered) {
            this.renderSessionEntry(session);
        }
    }

    private renderSessionEntry(session: PiSession): void {
        const isCurrent = this.currentSessionPath === session.path;
        const entry = this.listEl.createDiv({
            cls: `pi-session-entry${isCurrent ? " pi-session-entry-active" : ""}`,
        });

        // Main content area — clickable to switch
        const content = entry.createDiv({ cls: "pi-session-entry-content" });
        content.addEventListener("click", () => this.callbacks.onSwitch(session));

        // Name
        content.createDiv({
            cls: "pi-session-entry-name",
            text: session.name,
        });

        // Metadata line: date, message count, cwd
        const meta = content.createDiv({ cls: "pi-session-entry-meta" });
        meta.createSpan({ text: this.formatDate(session.mtime) });
        meta.createSpan({ text: ` · ${session.messageCount} msgs` });
        if (session.cwd) {
            meta.createSpan({
                text: ` · ${session.cwd}`,
                cls: "pi-session-entry-cwd",
            });
        }

        // Preview
        if (session.preview && session.preview !== "(empty session)") {
            content.createDiv({
                cls: "pi-session-entry-preview",
                text: session.preview,
            });
        }

        // Action buttons
        const actions = entry.createDiv({ cls: "pi-session-entry-actions" });

        const exportBtn = actions.createEl("button", {
            cls: "pi-session-action-btn",
            attr: { "aria-label": "Export to vault", title: "Export to vault" },
        });
        exportBtn.setText("📄");
        exportBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.callbacks.onExport(session);
        });

        const deleteBtn = actions.createEl("button", {
            cls: "pi-session-action-btn pi-session-action-delete",
            attr: { "aria-label": "Delete session", title: "Delete session" },
        });
        deleteBtn.setText("🗑");
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.confirmDelete(session);
        });
    }

    private async confirmDelete(session: PiSession): Promise<void> {
        // Simple confirmation via a second click — first click changes button
        // to "Sure?" text, second click actually deletes.
        const entry = this.listEl.querySelector(
            `.pi-session-entry-name[innerText="${session.name}"]`,
        )?.closest(".pi-session-entry");

        // Use Notice for confirmation since we can't easily do inline confirm
        const confirmed = confirm(`Delete session "${session.name}"?\nThis cannot be undone.`);
        if (!confirmed) return;

        try {
            await this.callbacks.onDelete(session);
            // Remove from local list and re-render
            this.sessions = this.sessions.filter((s) => s.path !== session.path);
            this.renderList();
            new Notice(`Deleted session: ${session.name}`);
        } catch (err) {
            console.error("[SessionPanel] Delete failed:", err);
            new Notice("Failed to delete session");
        }
    }

    private formatDate(mtime: number): string {
        const d = new Date(mtime);
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const isYesterday = d.toDateString() === yesterday.toDateString();

        const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

        if (isToday) return `Today ${time}`;
        if (isYesterday) return `Yesterday ${time}`;

        return d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
        }) + ` ${time}`;
    }
}
