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
import { SessionPanel } from "./session-panel";
import type { PiSession } from "./session-scanner";
import { unlink } from "fs/promises";

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
    private headerBar: HTMLElement | null = null;
    private headerSessionName: HTMLElement | null = null;
    private headerModel: HTMLElement | null = null;
    private headerCwd: HTMLElement | null = null;
    private isEditingName = false;
    private sessionPanel: SessionPanel | null = null;
    private messagesContainer: HTMLElement;
    private inputContainer: HTMLElement;
    private chatInput: ChatInput | null = null;
    private commandSuggest: CommandSuggest;
    private attachmentPicker: AttachmentPicker;
    private abortBtn: HTMLButtonElement | null = null;
    private readOnlyBanner: HTMLElement | null = null;
    private messages: ChatMessage[] = [];
    private readOnly = false;
    private streaming = false;

    /** Currently streaming assistant message element, used for live re-rendering */
    private streamingMessageEl: HTMLElement | null = null;

    /** Component for the final markdown render after streaming completes */
    private streamingComponent: Component | null = null;

    /** Debounce timer for live markdown re-rendering during streaming */
    private streamRenderTimer: ReturnType<typeof setTimeout> | null = null;

    /** Latest streamed content waiting to be rendered */
    private pendingStreamContent: string | null = null;

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

        // Header bar — session name, model, working directory
        this.headerBar = container.createDiv({ cls: "pi-header-bar" });
        this.buildHeaderBar(this.headerBar);

        // Chat body — session panel (hidden) + messages
        const chatBody = container.createDiv({ cls: "pi-chat-body" });

        // Session panel (sidebar within chat)
        this.sessionPanel = new SessionPanel(chatBody, {
            onSwitch: (session) => this.switchToSession(session),
            onDelete: (session) => this.deleteSession(session),
            onExport: (session) => this.exportSession(session),
        });

        // Scrollable messages area
        this.messagesContainer = chatBody.createDiv({ cls: "pi-messages" });

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

        // Track whether user has scrolled away from bottom
        this.messagesContainer.addEventListener("scroll", () => {
            const el = this.messagesContainer;
            const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            this.userScrolledUp = distFromBottom > 100;
        });

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
        if (this.streamRenderTimer) {
            clearTimeout(this.streamRenderTimer);
            this.streamRenderTimer = null;
        }
        this.pendingStreamContent = null;

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
        this.headerBar = null;
        this.headerSessionName = null;
        this.headerModel = null;
        this.headerCwd = null;
        if (this.sessionPanel) {
            this.sessionPanel.destroy();
            this.sessionPanel = null;
        }

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

    /** Whether the user has manually scrolled away from the bottom */
    private userScrolledUp = false;

    /**
     * Scroll the messages container to the bottom unless the user has scrolled up.
     */
    scrollToBottom(): void {
        if (this.userScrolledUp) return;
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    /**
     * Wire this view to a PiConnection's event stream.
     */
    connectToRpc(): void {
        const conn = this.plugin.ensureConnection();
        conn.onEvent((event) => {
            this.streamHandler.handleEvent(event);
            // Refresh header on agent_end (model/stats may have changed)
            if ((event.type as string) === "agent_end") {
                this.refreshHeader();
            }
        });
        this.commandSuggest.setConnection(conn);

        // Initial header refresh after connection
        setTimeout(() => this.refreshHeader(), 1000);
    }

    /**
     * Build the header bar contents: session name, model badge, cwd, new session button.
     */
    private buildHeaderBar(container: HTMLElement): void {
        const left = container.createDiv({ cls: "pi-header-left" });

        // Session name — click to edit
        this.headerSessionName = left.createSpan({
            cls: "pi-header-session-name",
            text: "New Session",
        });
        this.headerSessionName.setAttribute("title", "Click to rename session");
        this.headerSessionName.addEventListener("click", () => this.startEditingSessionName());

        // Model badge
        this.headerModel = left.createSpan({
            cls: "pi-header-model",
            text: "",
        });

        // Working directory
        this.headerCwd = left.createSpan({
            cls: "pi-header-cwd",
            text: "",
        });

        const right = container.createDiv({ cls: "pi-header-right" });

        // Sessions toggle button
        const sessionsBtn = right.createEl("button", {
            cls: "pi-header-sessions-btn",
            attr: { "aria-label": "Browse sessions" },
        });
        sessionsBtn.setText("📋");
        sessionsBtn.addEventListener("click", () => this.sessionPanel?.toggle());

        // New session button
        const newBtn = right.createEl("button", {
            cls: "pi-header-new-btn",
            attr: { "aria-label": "New session" },
        });
        newBtn.setText("+ New");
        newBtn.addEventListener("click", () => this.newSessionFromHeader());
    }

    /**
     * Refresh the header bar with current session state from Pi.
     */
    async refreshHeader(): Promise<void> {
        const conn = this.plugin.connection;
        if (!conn?.isConnected()) return;

        try {
            const response = await conn.send({ type: "get_state" });
            const data = response.data as Record<string, unknown> | undefined;
            if (!data) return;

            // Session name
            const sessionName = data.sessionName as string | undefined;
            const sessionFile = data.sessionFile as string | undefined;
            if (this.headerSessionName && !this.isEditingName) {
                const displayName = sessionName
                    || (sessionFile ? sessionFile.replace(/^.*\//, "").replace(/\.jsonl$/, "") : null)
                    || "New Session";
                this.headerSessionName.setText(displayName);
            }

            // Model
            const model = data.model as Record<string, unknown> | undefined;
            const modelName = model?.name as string | undefined;
            const thinkingLevel = data.thinkingLevel as string | undefined;
            if (this.headerModel) {
                let modelText = modelName || "";
                if (thinkingLevel && thinkingLevel !== "off") {
                    modelText += ` :${thinkingLevel}`;
                }
                this.headerModel.setText(modelText);
                this.headerModel.style.display = modelText ? "" : "none";
            }

            // Working directory
            const cwd = data.cwd as string | undefined;
            if (this.headerCwd) {
                // Show just the last directory component
                const shortCwd = cwd ? cwd.replace(/^.*\//, "") : "";
                this.headerCwd.setText(shortCwd ? `📁 ${shortCwd}` : "");
                this.headerCwd.style.display = shortCwd ? "" : "none";
                if (cwd) this.headerCwd.setAttribute("title", cwd);
            }
        } catch {
            // Non-fatal — header is informational
        }
    }

    /**
     * Start inline editing of the session name.
     */
    private startEditingSessionName(): void {
        if (this.isEditingName || !this.headerSessionName) return;
        this.isEditingName = true;

        const currentName = this.headerSessionName.getText();
        this.headerSessionName.empty();

        const input = this.headerSessionName.createEl("input", {
            cls: "pi-header-name-input",
            attr: { type: "text", value: currentName },
        });
        input.focus();
        input.select();

        const commit = async () => {
            const newName = input.value.trim();
            this.isEditingName = false;
            if (this.headerSessionName) {
                this.headerSessionName.empty();
                this.headerSessionName.setText(newName || currentName);
            }
            if (newName && newName !== currentName) {
                try {
                    const conn = this.plugin.ensureConnection();
                    await conn.send({ type: "set_session_name", name: newName });
                } catch (err) {
                    console.warn("[Pi Chat] Failed to rename session:", err);
                    new Notice("Failed to rename session");
                    // Revert
                    if (this.headerSessionName) {
                        this.headerSessionName.setText(currentName);
                    }
                }
            }
        };

        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                input.blur();
            } else if (e.key === "Escape") {
                this.isEditingName = false;
                if (this.headerSessionName) {
                    this.headerSessionName.empty();
                    this.headerSessionName.setText(currentName);
                }
            }
        });
    }

    /**
     * Create a new session from the header button.
     */
    private async newSessionFromHeader(): Promise<void> {
        // Save current if it has content
        if (this.hasMessages()) {
            try {
                await this.autoSave();
            } catch (err) {
                console.error("[Pi Chat] Auto-save before new session failed:", err);
            }
        }

        this.clearMessages();

        const conn = this.plugin.connection;
        if (conn?.isConnected()) {
            try {
                await conn.send({ type: "new_session" });
            } catch (err) {
                console.warn("[Pi Chat] new_session RPC failed:", err);
            }
        }

        // Reset header
        if (this.headerSessionName) this.headerSessionName.setText("New Session");
        new Notice("New session started");

        // Refresh after short delay for Pi to initialize
        setTimeout(() => this.refreshHeader(), 500);
    }

    /**
     * Switch to a Pi session by path.
     */
    private async switchToSession(session: PiSession): Promise<void> {
        // Save current session if needed
        if (this.hasMessages()) {
            try {
                await this.autoSave();
            } catch (err) {
                console.error("[Pi Chat] Auto-save before switch failed:", err);
            }
        }

        this.clearMessages();

        const conn = this.plugin.connection;
        if (conn?.isConnected()) {
            try {
                await conn.send({ type: "switch_session", sessionFile: session.path });
            } catch (err) {
                console.warn("[Pi Chat] switch_session RPC failed:", err);
                new Notice("Failed to switch session");
                return;
            }
        }

        // Update header and panel state
        if (this.headerSessionName) {
            this.headerSessionName.setText(session.name);
        }
        this.sessionPanel?.setCurrentSession(session.path);
        this.sessionPanel?.hide();
        new Notice(`Switched to: ${session.name}`);

        // Refresh header after switch
        setTimeout(() => this.refreshHeader(), 500);
    }

    /**
     * Delete a Pi session file.
     */
    private async deleteSession(session: PiSession): Promise<void> {
        await unlink(session.path);
    }

    /**
     * Export a Pi session to the vault as a markdown note.
     * This is a best-effort export — reads the .jsonl and converts to our markdown format.
     */
    private async exportSession(session: PiSession): Promise<void> {
        try {
            const { readFile } = await import("fs/promises");
            const content = await readFile(session.path, "utf-8");
            const lines = content.split("\n").filter((l) => l.trim());

            const messages: ChatMessage[] = [];
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.role === "user") {
                        const text = typeof entry.content === "string"
                            ? entry.content
                            : Array.isArray(entry.content)
                                ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
                                : "";
                        if (text) {
                            messages.push({
                                id: generateMessageId(),
                                role: "user",
                                content: text,
                                timestamp: Date.now(),
                            });
                        }
                    } else if (entry.role === "assistant") {
                        const text = typeof entry.content === "string"
                            ? entry.content
                            : Array.isArray(entry.content)
                                ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
                                : "";
                        if (text) {
                            messages.push({
                                id: generateMessageId(),
                                role: "assistant",
                                content: text,
                                timestamp: Date.now(),
                            });
                        }
                    }
                } catch {
                    // Skip malformed lines
                }
            }

            if (messages.length === 0) {
                new Notice("Session has no exportable messages");
                return;
            }

            const path = await this.sessionManager.saveSession(
                messages,
                this.plugin.settings,
                this.app.vault,
            );
            if (path) {
                new Notice(`Exported to ${path}`);
            } else {
                new Notice("Export failed — persistence may be disabled");
            }
        } catch (err) {
            console.error("[Pi Chat] Export failed:", err);
            new Notice("Failed to export session");
        }
    }

    /**
     * Send a user message to Pi, with optional attachments and images.
     */
    sendMessage(text: string, attachments: Attachment[] = []): void {
        if (this.readOnly) {
            new Notice("This is a saved session (read-only). Start a new session to chat.");
            return;
        }

        // User sent a message — follow the response
        this.userScrolledUp = false;

        const isSteering = this.streaming;

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
            isSteering: isSteering || undefined,
        };
        this.addMessage(userMsg);

        if (!isSteering) {
            this.setStreamingState(true);
        }

        // Build the RPC message
        let message = text;

        // Append file content as context (XML tags avoid triple-backtick escaping issues)
        for (const att of fileAttachments) {
            message += `\n\n<file path="${att.name}">\n${att.content}\n</file>`;
        }

        const conn = this.plugin.ensureConnection();

        // During streaming: steer the agent. Otherwise: new prompt.
        const command: Record<string, unknown> = {
            type: isSteering ? "steer" : "prompt",
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
            if (!isSteering) {
                this.setStreamingState(false);
            }
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
     * Toggle streaming state — shows/hides abort button, updates placeholder.
     * Input stays enabled so the user can send steering messages.
     */
    private setStreamingState(streaming: boolean): void {
        this.streaming = streaming;
        if (this.abortBtn) {
            this.abortBtn.style.display = streaming ? "inline-block" : "none";
        }
        if (this.chatInput) {
            this.chatInput.setPlaceholder(
                streaming
                    ? "Send a message to steer Pi…"
                    : "Message Pi… (/ for commands, @ for files)",
            );
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
     * Handle streaming text update — debounced live markdown rendering.
     */
    private handleStreamUpdate(msg: ChatMessage): void {
        if (!this.streamingMessageEl) {
            // First delta — create the assistant message container
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
            // Text is streaming — collapse live thinking block
            const liveThinking = this.streamingMessageEl.querySelector(".pi-thinking-live");
            if (liveThinking) {
                (liveThinking as HTMLDetailsElement).open = false;
                liveThinking.removeClass("pi-thinking-live");
            }

            // Schedule debounced markdown re-render
            this.pendingStreamContent = msg.content;
            if (!this.streamRenderTimer) {
                this.streamRenderTimer = setTimeout(() => {
                    this.streamRenderTimer = null;
                    this.renderStreamingMarkdown();
                }, 100);
            }
        } else if (msg.thinkingContent) {
            // Thinking in progress — show expandable live thinking block
            let thinkingEl = this.streamingMessageEl.querySelector(".pi-thinking-live") as HTMLDetailsElement | null;
            if (!thinkingEl) {
                thinkingEl = createEl("details", { cls: "pi-thinking pi-thinking-live" });
                thinkingEl.open = true;
                thinkingEl.createEl("summary", { text: "Thinking…" });
                thinkingEl.createDiv({ cls: "pi-thinking-content" });
                this.streamingMessageEl.insertBefore(thinkingEl, contentEl);
            }
            const thinkingContentEl = thinkingEl.querySelector(".pi-thinking-content");
            if (thinkingContentEl) {
                (thinkingContentEl as HTMLElement).setText(msg.thinkingContent);
            }
        }

        this.scrollToBottom();
    }

    /**
     * Render the latest streamed content as markdown.
     * Called on a debounce timer to avoid thrashing on every delta.
     */
    private renderStreamingMarkdown(): void {
        if (!this.streamingMessageEl || !this.pendingStreamContent) return;

        const contentEl = this.streamingMessageEl.querySelector(".pi-message-content");
        if (!contentEl) return;

        // Reuse or create a component for streaming renders
        if (this.streamingComponent) {
            this.streamingComponent.unload();
        }
        this.streamingComponent = new Component();
        this.streamingComponent.load();

        // Neutralize mermaid/dataview/etc. fences during streaming —
        // they break when re-rendered on partial content.
        // The final render in handleStreamComplete uses the real content.
        const safeContent = this.pendingStreamContent.replace(
            /```(mermaid|dataview|dataviewjs|query)/g,
            "```$1-preview",
        );

        contentEl.empty();
        try {
            MarkdownRenderer.render(
                this.app,
                safeContent,
                contentEl as HTMLElement,
                "",
                this.streamingComponent,
            );
        } catch (err) {
            console.error("[Pi Chat] Streaming markdown render error:", err);
            (contentEl as HTMLElement).setText(this.pendingStreamContent);
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

        // Cancel any pending debounced render
        if (this.streamRenderTimer) {
            clearTimeout(this.streamRenderTimer);
            this.streamRenderTimer = null;
        }
        this.pendingStreamContent = null;

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

            // Remove live thinking block — replaced by final rendered version
            const liveThinking = this.streamingMessageEl.querySelector(".pi-thinking-live, .pi-thinking");
            if (liveThinking) liveThinking.remove();

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
                    this.renderer.renderUserMessage(this.messagesContainer, msg.content, msg.isSteering);
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
