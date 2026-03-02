/**
 * File attachment picker for `@` references in the chat input.
 *
 * Opens Obsidian's FuzzySuggestModal with vault files. On selection,
 * reads the file content and adds it as an attachment to the chat input.
 */

import { App, FuzzySuggestModal, Notice, TFile } from "obsidian";
import type { Attachment } from "./input";

/**
 * Modal that shows vault files with fuzzy search for @ references.
 */
class FileSuggestModal extends FuzzySuggestModal<TFile> {
    private files: TFile[];
    private onSelect: (file: TFile) => void;

    constructor(app: App, files: TFile[], onSelect: (file: TFile) => void) {
        super(app);
        this.files = files;
        this.onSelect = onSelect;
        this.setPlaceholder("Attach a file...");
    }

    getItems(): TFile[] {
        return this.files;
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile, _evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(item);
    }
}

export class AttachmentPicker {
    private app: App;

    /** Extensions considered safe to read as text */
    private static TEXT_EXTENSIONS = new Set([
        "md", "txt", "json", "js", "ts", "jsx", "tsx",
        "py", "css", "html", "yaml", "yml", "xml", "csv",
        "toml", "ini", "cfg", "sh", "bash", "zsh",
        "java", "c", "cpp", "h", "hpp", "rs", "go",
        "rb", "php", "sql", "lua", "r", "swift", "kt",
        "scala", "ex", "exs", "hs", "ml", "clj",
        "env", "gitignore", "dockerfile", "svg", "log",
    ]);

    /** Max file size for attachments: 1MB */
    private static MAX_FILE_SIZE = 1024 * 1024;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Open the file picker modal. On selection, reads the file and
     * returns an Attachment via the callback.
     * Only shows text files to avoid binary corruption.
     */
    trigger(onAttach: (attachment: Attachment) => void): void {
        const allFiles = this.app.vault.getFiles();
        // Filter to text-only extensions to avoid reading binary files as text
        const files = allFiles.filter((f) =>
            AttachmentPicker.TEXT_EXTENSIONS.has(f.extension.toLowerCase())
        );

        const modal = new FileSuggestModal(
            this.app,
            files,
            async (file: TFile) => {
                try {
                    // Check file size before reading
                    const stat = await this.app.vault.adapter.stat(file.path);
                    if (stat && stat.size > AttachmentPicker.MAX_FILE_SIZE) {
                        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
                        new Notice(`File too large (${sizeMB}MB). Max 1MB.`);
                        return;
                    }

                    const content = await this.app.vault.cachedRead(file);
                    const attachment: Attachment = {
                        type: "file",
                        name: file.name,
                        content,
                        size: stat?.size,
                    };
                    onAttach(attachment);
                } catch (err) {
                    console.error("[Pi Attachments] Failed to read file:", err);
                    new Notice("Failed to read file");
                }
            },
        );
        modal.open();
    }
}
