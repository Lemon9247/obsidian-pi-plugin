/**
 * Shared message types for the Pi chat view.
 *
 * ChatMessage is the UI-facing representation of a conversation message.
 * Pi's RPC protocol uses different internal types (UserMessage, AssistantMessage,
 * ToolResultMessage) — the StreamHandler converts RPC events into ChatMessages.
 */

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: number;
    toolName?: string;
    toolCallId?: string;
    isStreaming?: boolean;
    thinkingContent?: string;
    isError?: boolean;
    /** Pi's internal entry ID, used for fork/session operations */
    piEntryId?: string;
}

/**
 * Generate a unique message ID.
 * Uses timestamp (base36) + random suffix to avoid collisions.
 */
export function generateMessageId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
