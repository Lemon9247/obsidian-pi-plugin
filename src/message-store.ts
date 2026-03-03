/**
 * Persistent message store — saves chat messages as JSON for each Pi session.
 *
 * This gives us fast history reload on session switch without parsing Pi's .jsonl format.
 * Messages are keyed by session file path and stored in the plugin's data directory.
 *
 * We use Obsidian's plugin data API (this.loadData/saveData) for persistence,
 * so the store is a simple in-memory map that serializes on save.
 */

import type { ChatMessage } from "./message-types";

/** Maximum messages stored per session to prevent unbounded growth */
const MAX_MESSAGES_PER_SESSION = 500;

/** In-memory message store, keyed by session path */
export interface MessageStoreData {
    sessions: Record<string, ChatMessage[]>;
    /** Last active session path */
    lastSession?: string;
}

export class MessageStore {
    private data: MessageStoreData;
    private dirty = false;

    constructor() {
        this.data = { sessions: {} };
    }

    /**
     * Load from serialized data (call with plugin.loadData() result).
     */
    load(raw: MessageStoreData | null): void {
        if (raw && typeof raw === "object" && raw.sessions) {
            this.data = raw;
        } else {
            this.data = { sessions: {} };
        }
        this.dirty = false;
    }

    /**
     * Get serializable data (pass to plugin.saveData()).
     */
    serialize(): MessageStoreData {
        this.dirty = false;
        return this.data;
    }

    /**
     * Check if there are unsaved changes.
     */
    isDirty(): boolean {
        return this.dirty;
    }

    /**
     * Get messages for a session.
     */
    getMessages(sessionPath: string): ChatMessage[] {
        return this.data.sessions[sessionPath] || [];
    }

    /**
     * Set all messages for a session (e.g. on save/clear).
     */
    setMessages(sessionPath: string, messages: ChatMessage[]): void {
        this.data.sessions[sessionPath] = messages.slice(-MAX_MESSAGES_PER_SESSION);
        this.dirty = true;
    }

    /**
     * Append a single message to a session.
     */
    appendMessage(sessionPath: string, message: ChatMessage): void {
        if (!this.data.sessions[sessionPath]) {
            this.data.sessions[sessionPath] = [];
        }
        this.data.sessions[sessionPath].push(message);

        // Trim if over limit
        if (this.data.sessions[sessionPath].length > MAX_MESSAGES_PER_SESSION) {
            this.data.sessions[sessionPath] = this.data.sessions[sessionPath].slice(-MAX_MESSAGES_PER_SESSION);
        }
        this.dirty = true;
    }

    /**
     * Remove a session's messages.
     */
    removeSession(sessionPath: string): void {
        delete this.data.sessions[sessionPath];
        this.dirty = true;
    }

    /**
     * Get the last active session path.
     */
    getLastSession(): string | undefined {
        return this.data.lastSession;
    }

    /**
     * Set the last active session path.
     */
    setLastSession(sessionPath: string | undefined): void {
        this.data.lastSession = sessionPath;
        this.dirty = true;
    }

    /**
     * List all session paths that have stored messages, sorted by most recent message.
     */
    listSessions(): string[] {
        return Object.keys(this.data.sessions)
            .filter((key) => this.data.sessions[key].length > 0)
            .sort((a, b) => {
                const aLast = this.data.sessions[a].slice(-1)[0]?.timestamp ?? 0;
                const bLast = this.data.sessions[b].slice(-1)[0]?.timestamp ?? 0;
                return bLast - aLast;
            });
    }
}
