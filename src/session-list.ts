/**
 * Session list modal — browse and load saved conversations.
 *
 * Shows all markdown files in the session save directory with
 * date and preview text. Selecting a session loads it into the
 * chat view as a read-only display.
 */

import { App, FuzzySuggestModal, TFile } from "obsidian";

export interface SessionEntry {
    file: TFile;
    date: string;
    preview: string;
}

/**
 * Modal that lists saved sessions with fuzzy search.
 * Shows date and first user message as preview.
 */
export class SessionListModal extends FuzzySuggestModal<SessionEntry> {
    private entries: SessionEntry[];
    private onSelect: (entry: SessionEntry) => void;

    constructor(
        app: App,
        entries: SessionEntry[],
        onSelect: (entry: SessionEntry) => void,
    ) {
        super(app);
        this.entries = entries;
        this.onSelect = onSelect;
        this.setPlaceholder("Browse saved sessions...");
    }

    getItems(): SessionEntry[] {
        return this.entries;
    }

    getItemText(item: SessionEntry): string {
        return `${item.date} ${item.preview}`;
    }

    onChooseItem(item: SessionEntry, _evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item);
    }

    renderSuggestion(
        item: { item: SessionEntry; match: { score: number; matches: any[] } },
        el: HTMLElement,
    ): void {
        const wrapper = el.createDiv({ cls: "pi-session-suggest-item" });
        wrapper.createDiv({ text: item.item.date, cls: "pi-session-date" });
        wrapper.createDiv({ text: item.item.preview, cls: "pi-session-preview" });
    }
}

/**
 * Build session entries from markdown files in the session save directory.
 * Returns entries sorted newest-first.
 */
export async function buildSessionEntries(
    app: App,
    sessionDir: string,
): Promise<SessionEntry[]> {
    const entries: SessionEntry[] = [];

    const files = app.vault
        .getFiles()
        .filter(
            (f) =>
                f.path.startsWith(sessionDir + "/") &&
                f.extension === "md",
        );

    // Sort newest first by modification time
    files.sort((a, b) => b.stat.mtime - a.stat.mtime);

    for (const file of files) {
        const content = await app.vault.cachedRead(file);
        const preview = extractPreview(content);
        const date = formatFileDate(file.basename);

        entries.push({ file, date, preview });
    }

    return entries;
}

/**
 * Extract first user message as preview text.
 */
function extractPreview(content: string): string {
    const match = content.match(/> \[!user\]\n> (.+)/);
    if (match) {
        const text = match[1].trim();
        return text.length > 60 ? text.slice(0, 60) + "…" : text;
    }
    return "(empty session)";
}

/**
 * Format a session filename (YYYY-MM-DD-HH-mm) for display.
 */
function formatFileDate(basename: string): string {
    const match = basename.match(
        /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/,
    );
    if (match) {
        const [, y, m, d, h, min] = match;
        return `${y}-${m}-${d} ${h}:${min}`;
    }
    return basename;
}
