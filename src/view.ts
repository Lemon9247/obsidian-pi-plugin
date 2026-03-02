import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type PiPlugin from "./main";
import { MessageRenderer } from "./renderer";
import { StreamHandler } from "./stream-handler";
import type { ChatMessage } from "./message-types";
import { generateMessageId } from "./message-types";

export const VIEW_TYPE_PI_CHAT = "pi-chat-view";

/**
 * Obsidian ItemView that displays a chat conversation with Pi.
 * Messages are rendered as native Obsidian markdown.
 */
export class PiChatView extends ItemView {
    plugin: PiPlugin;
    private renderer: MessageRenderer;
    private streamHandler: StreamHandler;
    private messagesContainer: HTMLElement;
    private inputContainer: HTMLElement;
    private messages: ChatMessage[] = [];

    /** Currently streaming assistant message element, used for live re-rendering */
    private streamingMessageEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: PiPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.renderer = new MessageRenderer(this.app);
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

        // Input placeholder — Phase 3 will replace this with the real input component
        this.inputContainer = container.createDiv({ cls: "pi-input-container" });
        this.inputContainer.createEl("span", {
            text: "Input will be added in Phase 3",
            cls: "pi-input-placeholder",
        });
    }

    async onClose(): Promise<void> {
        this.messages = [];
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
     * Scroll the messages container to the bottom.
     */
    scrollToBottom(): void {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    /**
     * Wire this view to a PiConnection's event stream.
     */
    connectToRpc(): void {
        const conn = this.plugin.ensureConnection();
        conn.onEvent((event) => this.streamHandler.handleEvent(event));
    }

    /**
     * Send a user message to Pi.
     */
    sendMessage(text: string): void {
        const userMsg: ChatMessage = {
            id: generateMessageId(),
            role: "user",
            content: text,
            timestamp: Date.now(),
        };
        this.addMessage(userMsg);

        const conn = this.plugin.ensureConnection();
        conn.send({ type: "prompt", message: text });
    }

    /**
     * Handle streaming text update — re-render markdown live.
     */
    private handleStreamUpdate(msg: ChatMessage): void {
        if (!this.streamingMessageEl) {
            // First delta — create the assistant message container
            this.streamingMessageEl = this.renderer.renderAssistantMessage(
                this.messagesContainer,
                msg.content,
                "",
                this,
            );
        } else {
            // Re-render: clear content div and re-render markdown
            const contentEl = this.streamingMessageEl.querySelector(".pi-message-content");
            if (contentEl) {
                contentEl.empty();
                if (msg.content) {
                    MarkdownRenderer.render(this.app, msg.content, contentEl as HTMLElement, "", this);
                }
            }
        }
        this.scrollToBottom();
    }

    /**
     * Handle stream completion — finalize the message.
     */
    private handleStreamComplete(msg: ChatMessage): void {
        // If we were streaming, do a final re-render
        if (this.streamingMessageEl) {
            const contentEl = this.streamingMessageEl.querySelector(".pi-message-content");
            if (contentEl) {
                contentEl.empty();
                if (msg.content) {
                    MarkdownRenderer.render(this.app, msg.content, contentEl as HTMLElement, "", this);
                }
            }

            // Add thinking content as a collapsed details element
            if (msg.thinkingContent) {
                const thinkingEl = this.streamingMessageEl.createEl("details", { cls: "pi-thinking" });
                thinkingEl.createEl("summary", { text: "Thinking..." });
                const thinkingContent = thinkingEl.createDiv({ cls: "pi-thinking-content" });
                MarkdownRenderer.render(this.app, msg.thinkingContent, thinkingContent, "", this);
            }

            this.streamingMessageEl = null;
        }

        this.messages.push(msg);
        this.scrollToBottom();
    }

    private renderMessage(msg: ChatMessage): void {
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
    }
}
