import { ItemView, WorkspaceLeaf } from "obsidian";
import type PiPlugin from "./main";
import { MessageRenderer } from "./renderer";

export const VIEW_TYPE_PI_CHAT = "pi-chat-view";

/**
 * Represents a chat message in the UI.
 */
export interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    timestamp: number;
    toolName?: string;
    toolCallId?: string;
    isStreaming?: boolean;
    isError?: boolean;
    thinkingContent?: string;
}

/**
 * Obsidian ItemView that displays a chat conversation with Pi.
 * Messages are rendered as native Obsidian markdown.
 */
export class PiChatView extends ItemView {
    plugin: PiPlugin;
    private renderer: MessageRenderer;
    private messagesContainer: HTMLElement;
    private inputContainer: HTMLElement;
    private messages: ChatMessage[] = [];

    /** Currently streaming assistant message element, used by streaming logic */
    streamingMessageEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: PiPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.renderer = new MessageRenderer(this.app);
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
