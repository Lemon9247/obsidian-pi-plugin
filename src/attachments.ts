/**
 * File attachment picker for `@` references in the chat input.
 *
 * Opens Obsidian's FuzzySuggestModal with vault files. On selection,
 * reads the file content and adds it as an attachment to the chat input.
 */

import { App, FuzzySuggestModal, TFile } from "obsidian";
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

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Open the file picker modal. On selection, reads the file and
     * returns an Attachment via the callback.
     */
    trigger(onAttach: (attachment: Attachment) => void): void {
        const files = this.app.vault.getFiles();

        const modal = new FileSuggestModal(
            this.app,
            files,
            async (file: TFile) => {
                try {
                    const content = await this.app.vault.cachedRead(file);
                    const attachment: Attachment = {
                        type: "file",
                        name: file.name,
                        content,
                    };
                    onAttach(attachment);
                } catch (err) {
                    console.error("[Pi Attachments] Failed to read file:", err);
                }
            },
        );
        modal.open();
    }
}
