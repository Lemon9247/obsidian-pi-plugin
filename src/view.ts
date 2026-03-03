import { Component, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type PiPlugin from "./main";
import { MessageRenderer } from "./renderer";
import { StreamHandler } from "./stream-handler";
import type { ChatMessage } from "./message-types";
import { generateMessageId } from "./message-types";
import { ChatInput } from "./input";
import type { Attachment } from "./input";
import { CommandSuggest } from "./commands";
import { AttachmentPicker } from "./attachments";
import { SessionManager } from "./sessions";

export const VIEW_TYPE_PI_CHAT = "pi-chat-view";

/**
 * Obsidian ItemView that displays a chat conversation with Pi.
 * Messages are rendered as native Obsidian markdown.
 */
export class PiChatView extends ItemView {
    plugin: PiPlugin;
    private renderer: MessageRenderer;
    private streamHandler: StreamHandler;
    private sessionManager: SessionManager;
    private messagesContainer: HTMLElement;
    private inputContainer: HTMLElement;
    private chatInput: ChatInput | null = null;
    private commandSuggest: CommandSuggest;
    private attachmentPicker: AttachmentPicker;
    private abortBtn: HTMLButtonElement | null = null;
    private readOnlyBanner: HTMLElement | null = null;
    private messages: ChatMessage[] = [];
    private readOnly = false;

    /** Currently streaming assistant message element, used for live re-rendering */
    private streamingMessageEl: HTMLElement | null = null;

    /** Component for the final markdown render after streaming completes */
    private streamingComponent: Component | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: PiPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.renderer = new MessageRenderer(this.app);
        this.sessionManager = new SessionManager();
        this.commandSuggest = new CommandSuggest(this.app);
        this.attachmentPicker = new AttachmentPicker(this.app);
        this.streamHandler = new StreamHandler({
            onMessageUpdate: (msg) => this.handleStreamUpdate(msg),
            onMessageComplete: (msg) => this.handleStreamComplete(msg),
            onToolResult: (msg) => this.addMessage(msg),
            onCompaction: () => new Notice("Pi conversation compacted"),
            onError: (err) => new Notice(`Pi error: ${err}`),
        });
    }

    getViewType(): string {
        return VIEW_TYPE_PI_CHAT;
    }

    getDisplayText(): string {
        return "Pi Chat";
    }

    getIcon(): string {
        return "message-circle";
    }

    async onOpen(): Promise<void> {
        const container = this.contentEl;
        container.empty();
        container.addClass("pi-chat-container");

        // Scrollable messages area
        this.messagesContainer = container.createDiv({ cls: "pi-messages" });

        // Input container with ChatInput, abort button, and attachment support
        this.inputContainer = container.createDiv({ cls: "pi-input-container" });
        this.chatInput = new ChatInput(this.inputContainer, {
            onSend: (text, attachments) => this.sendMessage(text, attachments),
            onSlashTyped: () => this.triggerCommandSuggest(),
            onAtTyped: () => this.triggerFilePicker(),
        });

        // Add abort button to the input area (hidden by default)
        this.abortBtn = this.chatInput.getInputAreaEl().createEl("button", {
            cls: "pi-abort-btn",
            text: "Abort",
            attr: { style: "display: none;" },
        });
        this.abortBtn.addEventListener("click", () => this.abortStream());

        this.chatInput.focus();

        // Wire up RPC event stream so responses are rendered
        this.connectToRpc();
    }

    async onClose(): Promise<void> {
        // Auto-save conversation before closing (skip read-only loaded sessions)
        if (!this.readOnly) {
            try {
                await this.autoSave();
            } catch (err) {
                console.error("[Pi Chat] Failed to auto-save on close:", err);
                // Continue with cleanup even if save fails
            }
        }

        // Clean up streaming state
        this.streamHandler.reset();

        // Unload any active streaming component
        if (this.streamingComponent) {
            this.streamingComponent.unload();
            this.streamingComponent = null;
        }

        // Clean up input components
        if (this.chatInput) {
            this.chatInput.destroy();
            this.chatInput = null;
        }
        this.abortBtn = null;
        this.readOnlyBanner = null;

        // Clear view state
        this.messages = [];
        this.readOnly = false;
        this.streamingMessageEl = null;
        this.contentEl.empty();
    }

    /**
     * Add a message to the chat and render it.
     */
    addMessage(msg: ChatMessage): void {
        this.messages.push(msg);
        this.renderMessage(msg);
        this.scrollToBottom();
    }

    /**
     * Get all messages in the conversation.
     */
    getMessages(): ChatMessage[] {
        return [...this.messages];
    }

    /**
     * Get the messages container element (used by streaming logic to append live content).
     */
    getMessagesContainer(): HTMLElement {
        return this.messagesContainer;
    }

    /**
     * Scroll the messages container to the bottom, but only if user is already near the bottom.
     * This prevents forcibly scrolling the user away from content they're reading.
     */
    scrollToBottom(): void {
        const el = this.messagesContainer;
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
        if (isAtBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    /**
     * Wire this view to a PiConnection's event stream.
     */
    connectToRpc(): void {
        const conn = this.plugin.ensureConnection();
        conn.onEvent((event) => this.streamHandler.handleEvent(event));
        this.commandSuggest.setConnection(conn);
    }

    /**
     * Send a user message to Pi, with optional attachments and images.
     */
    sendMessage(text: string, attachments: Attachment[] = []): void {
        if (this.readOnly) {
            new Notice("This is a saved session (read-only). Start a new session to chat.");
            return;
        }

        // Build the display text (include attachment names)
        let displayText = text;
        const fileAttachments = attachments.filter((a) => a.type === "file");
        if (fileAttachments.length > 0) {
            const names = fileAttachments.map((a) => a.name).join(", ");
            displayText += `\n\n📎 Attached: ${names}`;
        }
        const imageAttachments = attachments.filter((a) => a.type === "image");
        if (imageAttachments.length > 0) {
            displayText += `\n\n🖼 ${imageAttachments.length} image(s) attached`;
        }

        const userMsg: ChatMessage = {
            id: generateMessageId(),
            role: "user",
            content: displayText,
            timestamp: Date.now(),
        };
        this.addMessage(userMsg);

        // Disable input during streaming
        this.setStreamingState(true);

        // Build the RPC message
        let message = text;

        // Append file content as context (XML tags avoid triple-backtick escaping issues)
        for (const att of fileAttachments) {
            message += `\n\n<file path="${att.name}">\n${att.content}\n</file>`;
        }

        const conn = this.plugin.ensureConnection();

        // Build command — include images if present
        const command: Record<string, unknown> = {
            type: "prompt",
            message,
        };

        if (imageAttachments.length > 0) {
            command.images = imageAttachments.map((img) => ({
                type: "image",
                data: img.content,
                mimeType: img.mimeType || "image/png",
            }));
        }

        try {
            conn.send(command);
        } catch (err) {
            console.error("[Pi Chat] Failed to send message:", err);
            new Notice("Failed to send message to Pi");
            this.setStreamingState(false);
        }
    }

    /**
     * Check if the conversation has any messages worth saving.
     */
    hasMessages(): boolean {
        return this.messages.some((m) => m.role === "assistant");
    }

    /**
     * Auto-save the current conversation if it has content.
     */
    async autoSave(): Promise<string | null> {
        if (!this.hasMessages()) return null;
        try {
            const path = await this.sessionManager.saveSession(
                this.messages,
                this.plugin.settings,
                this.app.vault,
            );
            if (path) {
                console.log("[Pi Chat] Session saved to:", path);
            }
            return path;
        } catch (err) {
            console.error("[Pi Chat] Failed to auto-save session:", err);
            return null;
        }
    }

    /**
     * Clear all messages and reset the view for a new conversation.
     */
    clearMessages(): void {
        this.messages = [];
        this.readOnly = false;
        this.streamHandler.reset();

        if (this.streamingComponent) {
            this.streamingComponent.unload();
            this.streamingComponent = null;
        }
        this.streamingMessageEl = null;

        // Clear DOM
        this.messagesContainer.empty();

        // Remove read-only banner if present
        if (this.readOnlyBanner) {
            this.readOnlyBanner.remove();
            this.readOnlyBanner = null;
        }

        // Re-enable input
        this.setReadOnly(false);
    }

    /**
     * Reset view state after an RPC disconnect during streaming.
     * Re-enables input, clears streaming state, and annotates any
     * partial assistant message with a connection-lost marker.
     */
    handleDisconnect(): void {
        this.streamHandler.reset();
        this.setStreamingState(false);

        if (this.streamingMessageEl) {
            const contentEl = this.streamingMessageEl.querySelector(".pi-message-content");
            if (contentEl) {
                const existing = (contentEl as HTMLElement).getText();
                (contentEl as HTMLElement).setText(existing + "\n\n*[Connection lost]*");
            }
            this.streamingMessageEl = null;
        }

        if (this.streamingComponent) {
            this.streamingComponent.unload();
            this.streamingComponent = null;
        }
    }

    /**
     * Display a list of messages (e.g. from a loaded session).
     * Optionally marks the view as read-only.
     */
    displayMessages(messages: ChatMessage[], readOnly = false): void {
        this.clearMessages();
        this.messages = [...messages];
        this.readOnly = readOnly;

        for (const msg of messages) {
            this.renderMessage(msg);
        }

        if (readOnly) {
            this.setReadOnly(true);
        }

        this.scrollToBottom();
    }

    /**
     * Set read-only mode — disables input and shows a banner.
     */
    private setReadOnly(readOnly: boolean): void {
        this.readOnly = readOnly;

        if (this.chatInput) {
            this.chatInput.setEnabled(!readOnly);
        }

        if (readOnly) {
            if (!this.readOnlyBanner) {
                this.readOnlyBanner = this.contentEl.createDiv({
                    cls: "pi-readonly-banner",
                });
                // Insert before the input container
                this.contentEl.insertBefore(this.readOnlyBanner, this.inputContainer);
                this.readOnlyBanner.setText("📖 Viewing saved session");
            }
        } else {
            if (this.readOnlyBanner) {
                this.readOnlyBanner.remove();
                this.readOnlyBanner = null;
            }
        }
    }

    /**
     * Toggle streaming state — disables/enables input, shows/hides abort button.
     */
    private setStreamingState(streaming: boolean): void {
        if (this.chatInput) {
            this.chatInput.setEnabled(!streaming);
        }
        if (this.abortBtn) {
            this.abortBtn.style.display = streaming ? "inline-block" : "none";
        }
    }

    /**
     * Abort the current stream by sending abort command to Pi.
     */
    private abortStream(): void {
        try {
            const conn = this.plugin.ensureConnection();
            conn.send({ type: "abort" });
        } catch (err) {
            console.warn("[Pi Chat] Failed to send abort:", err);
            new Notice("Connection lost — resetting view");
        } finally {
            // Always reset streaming state so user can recover
            this.setStreamingState(false);
        }
    }

    /**
     * Trigger the `/` command suggest modal.
     */
    private triggerCommandSuggest(): void {
        // Wire up the connection for fetching commands
        try {
            const conn = this.plugin.ensureConnection();
            this.commandSuggest.setConnection(conn);
        } catch {
            // Connection may not be available yet — use fallback commands
        }

        this.commandSuggest.trigger((commandText) => {
            if (this.chatInput) {
                this.chatInput.setValue(commandText);
                this.chatInput.focus();
            }
        });
    }

    /**
     * Trigger the `@` file picker modal.
     */
    private triggerFilePicker(): void {
        this.attachmentPicker.trigger((attachment) => {
            if (this.chatInput) {
                // Remove the `@` character that triggered this
                const current = this.chatInput.getValue();
                if (current.endsWith("@")) {
                    this.chatInput.setValue(current.slice(0, -1));
                }
                this.chatInput.addAttachment(attachment);
                this.chatInput.focus();
            }
        });
    }

    /**
     * Handle streaming text update — use plaintext during streaming for performance.
     * Full markdown rendering happens on completion in handleStreamComplete().
     */
    private handleStreamUpdate(msg: ChatMessage): void {
        if (!this.streamingMessageEl) {
            // First delta — create the assistant message container with plaintext
            this.streamingMessageEl = this.messagesContainer.createDiv({
                cls: "pi-message pi-message-assistant",
            });
            const label = this.streamingMessageEl.createDiv({ cls: "pi-message-label" });
            label.createSpan({ text: "Pi", cls: "pi-message-label-text" });
            this.streamingMessageEl.createDiv({ cls: "pi-message-content" });
        }

        const contentEl = this.streamingMessageEl.querySelector(".pi-message-content");
        if (!contentEl) return;

        if (msg.content) {
            // Text is streaming — show it and remove thinking indicator
            const indicator = this.streamingMessageEl.querySelector(".pi-thinking-indicator");
            if (indicator) indicator.remove();
            (contentEl as HTMLElement).setText(msg.content);
        } else if (msg.thinkingContent) {
            // Thinking in progress, no text yet — show live indicator
            if (!this.streamingMessageEl.querySelector(".pi-thinking-indicator")) {
                const indicator = createDiv({ cls: "pi-thinking-indicator" });
                indicator.setText("Thinking…");
                this.streamingMessageEl.insertBefore(indicator, contentEl);
            }
        }

        this.scrollToBottom();
    }

    /**
     * Handle stream completion — do full markdown render and finalize the message.
     */
    private handleStreamComplete(msg: ChatMessage): void {
        // Re-enable input
        this.setStreamingState(false);
        if (this.chatInput) {
            this.chatInput.focus();
        }

        // If we were streaming, do a final markdown render
        if (this.streamingMessageEl) {
            // Clean up any previous streaming component
            if (this.streamingComponent) {
                this.streamingComponent.unload();
                this.streamingComponent = null;
            }

            const contentEl = this.streamingMessageEl.querySelector(".pi-message-content");
            if (contentEl) {
                contentEl.empty();
                if (msg.content) {
                    this.streamingComponent = new Component();
                    this.streamingComponent.load();
                    try {
                        MarkdownRenderer.render(
                            this.app,
                            msg.content,
                            contentEl as HTMLElement,
                            "",
                            this.streamingComponent,
                        );
                    } catch (err) {
                        console.error("[Pi Chat] Markdown rendering error:", err);
                        (contentEl as HTMLElement).setText(msg.content);
                    }
                }
            }

            // Remove live thinking indicator
            const indicator = this.streamingMessageEl.querySelector(".pi-thinking-indicator");
            if (indicator) indicator.remove();

            // Add thinking content as a collapsed details element BEFORE the response text
            if (msg.thinkingContent) {
                // Ensure we have a component for rendering (may not exist if no main content)
                if (!this.streamingComponent) {
                    this.streamingComponent = new Component();
                    this.streamingComponent.load();
                }
                const thinkingEl = createEl("details", { cls: "pi-thinking" });
                thinkingEl.createEl("summary", { text: "Thinking…" });
                const thinkingContentEl = thinkingEl.createDiv({ cls: "pi-thinking-content" });
                try {
                    MarkdownRenderer.render(
                        this.app,
                        msg.thinkingContent,
                        thinkingContentEl,
                        "",
                        this.streamingComponent,
                    );
                } catch (err) {
                    console.error("[Pi Chat] Thinking render error:", err);
                    thinkingContentEl.setText(msg.thinkingContent);
                }
                // Insert before the content div so thinking appears above the response
                this.streamingMessageEl.insertBefore(thinkingEl, contentEl);
            }

            this.streamingMessageEl = null;
        }

        // Always push message, even if the streaming element was cleaned up
        this.messages.push(msg);
        this.scrollToBottom();
    }

    private renderMessage(msg: ChatMessage): void {
        try {
            switch (msg.role) {
                case "user":
                    this.renderer.renderUserMessage(this.messagesContainer, msg.content);
                    break;
                case "assistant":
                    this.renderer.renderAssistantMessage(
                        this.messagesContainer,
                        msg.content,
                        "",
                        this,
                        msg.thinkingContent,
                    );
                    break;
                case "tool":
                    this.renderer.renderToolCall(
                        this.messagesContainer,
                        msg.toolName ?? "tool",
                        "",
                        msg.content,
                        msg.isError ?? false,
                        this,
                    );
                    break;
            }
        } catch (err) {
            console.error("[Pi Chat] Message render error:", err);
            const errorEl = this.messagesContainer.createDiv({ cls: "pi-message pi-render-error" });
            errorEl.createEl("p", { text: "⚠️ Failed to render message" });
            errorEl.createEl("pre", { text: msg.content });
        }
    }
}
