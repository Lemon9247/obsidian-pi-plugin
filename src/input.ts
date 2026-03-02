/**
 * Chat input component for the Pi chat view.
 *
 * Provides a textarea with:
 * - Enter to send, Shift+Enter for newline
 * - Auto-resize up to a max height
 * - Enable/disable during streaming
 * - Image paste support (base64)
 * - Attachment chips display
 */

import { Notice } from "obsidian";

export interface Attachment {
    type: 'file' | 'image';
    name: string;
    content: string;       // text content for files, base64 for images
    mimeType?: string;     // e.g. 'image/png' for images
    size?: number;         // file size in bytes (shown in attachment chip)
}

export interface ChatInputCallbacks {
    onSend: (text: string, attachments: Attachment[]) => void;
    onSlashTyped?: () => void;
    onAtTyped?: () => void;
}

export class ChatInput {
    private containerEl: HTMLElement;
    private textareaEl: HTMLTextAreaElement;
    private attachmentsEl: HTMLElement;
    private callbacks: ChatInputCallbacks;
    private attachments: Attachment[] = [];
    private enabled = true;

    constructor(containerEl: HTMLElement, callbacks: ChatInputCallbacks) {
        this.containerEl = containerEl;
        this.callbacks = callbacks;
        this.containerEl.empty();

        // Attachments row (above input)
        this.attachmentsEl = this.containerEl.createDiv({ cls: "pi-attachments" });

        // Input area with textarea
        const inputArea = this.containerEl.createDiv({ cls: "pi-input-area" });

        this.textareaEl = inputArea.createEl("textarea", {
            cls: "pi-input-textarea",
            attr: {
                placeholder: "Message Pi... (/ for commands, @ for files)",
                rows: "1",
            },
        });

        this.textareaEl.addEventListener("keydown", (e) => this.handleKeydown(e));
        this.textareaEl.addEventListener("input", () => this.autoResize());
        this.textareaEl.addEventListener("paste", (e) => this.handlePaste(e));
    }

    /**
     * Focus the textarea.
     */
    focus(): void {
        this.textareaEl.focus();
    }

    /**
     * Enable or disable the input. Disabled during streaming.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        this.textareaEl.disabled = !enabled;
        if (enabled) {
            this.textareaEl.classList.remove("pi-input-disabled");
        } else {
            this.textareaEl.classList.add("pi-input-disabled");
        }
    }

    /**
     * Get the current text value.
     */
    getValue(): string {
        return this.textareaEl.value;
    }

    /**
     * Set the textarea value programmatically (used by command completion).
     */
    setValue(text: string): void {
        this.textareaEl.value = text;
        this.autoResize();
    }

    /**
     * Add an attachment (file or image) and show it as a chip.
     */
    addAttachment(attachment: Attachment): void {
        this.attachments.push(attachment);
        this.renderAttachments();
    }

    /**
     * Remove an attachment by index.
     */
    removeAttachment(index: number): void {
        if (index >= 0 && index < this.attachments.length) {
            this.attachments.splice(index, 1);
            this.renderAttachments();
        }
    }

    /**
     * Get current attachments.
     */
    getAttachments(): Attachment[] {
        return [...this.attachments];
    }

    /**
     * Clear all attachments.
     */
    clearAttachments(): void {
        this.attachments = [];
        this.renderAttachments();
    }

    /**
     * Get the input area element (for appending abort button, etc).
     */
    getInputAreaEl(): HTMLElement {
        return this.textareaEl.parentElement!;
    }

    /**
     * Clean up event listeners.
     */
    destroy(): void {
        this.containerEl.empty();
        this.attachments = [];
    }

    // --- Private ---

    private handleKeydown(e: KeyboardEvent): void {
        if (!this.enabled) return;

        // Enter sends, Shift+Enter inserts newline
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            this.send();
            return;
        }

        // Trigger slash command suggest when `/` typed as first char
        if (e.key === "/" && this.callbacks.onSlashTyped) {
            // Check after the character is inserted (keydown fires before insertion)
            setTimeout(() => {
                if (this.textareaEl.value.startsWith("/")) {
                    this.callbacks.onSlashTyped!();
                }
            }, 0);
        }

        // Trigger @ file picker when `@` typed
        if (e.key === "@" && this.callbacks.onAtTyped) {
            setTimeout(() => this.callbacks.onAtTyped!(), 0);
        }
    }

    private send(): void {
        const text = this.textareaEl.value.trim();
        if (!text && this.attachments.length === 0) return;

        this.callbacks.onSend(text, [...this.attachments]);
        this.textareaEl.value = "";
        this.attachments = [];
        this.renderAttachments();
        this.autoResize();
    }

    private autoResize(): void {
        const el = this.textareaEl;
        el.style.height = "auto";
        // Clamp to max-height defined in CSS (200px)
        const maxHeight = 200;
        el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
    }

    private handlePaste(e: ClipboardEvent): void {
        if (!e.clipboardData) return;

        const items = e.clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith("image/")) {
                e.preventDefault();
                const file = item.getAsFile();
                if (!file) continue;

                const mimeType = item.type;
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result;
                    if (typeof result !== "string") {
                        console.error("[ChatInput] Failed to read image as data URL");
                        return;
                    }
                    // Strip the data:image/xxx;base64, prefix to get raw base64
                    const parts = result.split(",");
                    if (parts.length < 2) {
                        console.error("[ChatInput] Invalid data URL format");
                        return;
                    }
                    const base64 = parts[1];
                    // Reject images over 5MB (base64 is ~1.33x original)
                    const sizeBytes = (base64.length * 3) / 4;
                    if (sizeBytes > 5 * 1024 * 1024) {
                        new Notice(`Image too large (${(sizeBytes / (1024 * 1024)).toFixed(1)}MB). Max 5MB.`);
                        return;
                    }
                    this.addAttachment({
                        type: "image",
                        name: `pasted-image-${Date.now()}.${mimeType.split("/")[1] || "png"}`,
                        content: base64,
                        mimeType,
                        size: sizeBytes,
                    });
                };
                reader.onerror = () => {
                    console.error("[ChatInput] FileReader error:", reader.error);
                };
                reader.readAsDataURL(file);
                break; // Only handle first image
            }
        }
    }

    private renderAttachments(): void {
        this.attachmentsEl.empty();
        if (this.attachments.length === 0) {
            this.attachmentsEl.style.display = "none";
            return;
        }

        this.attachmentsEl.style.display = "flex";

        this.attachments.forEach((att, index) => {
            const chip = this.attachmentsEl.createDiv({ cls: "pi-attachment-chip" });

            if (att.type === "image") {
                // Show tiny thumbnail for images
                const thumb = chip.createEl("img", {
                    cls: "pi-attachment-thumb",
                    attr: {
                        src: `data:${att.mimeType};base64,${att.content}`,
                        alt: att.name,
                    },
                });
                thumb.style.width = "16px";
                thumb.style.height = "16px";
                thumb.style.objectFit = "cover";
                thumb.style.borderRadius = "2px";
            }

            chip.createSpan({
                text: att.name,
                cls: "pi-attachment-name",
                attr: { title: att.name },
            });
            if (att.size != null) {
                const sizeKB = att.size / 1024;
                const sizeText = sizeKB >= 1024
                    ? `${(sizeKB / 1024).toFixed(1)} MB`
                    : `${sizeKB.toFixed(1)} KB`;
                chip.createSpan({ text: ` (${sizeText})`, cls: "pi-attachment-size" });
            }

            const removeBtn = chip.createSpan({
                text: "×",
                cls: "pi-attachment-remove",
                attr: { "aria-label": "Remove attachment" },
            });
            removeBtn.addEventListener("click", () => {
                this.removeAttachment(index);
                this.focus();
            });
        });
    }
}
