/**
 * Processes RPC events from Pi and manages streaming state.
 *
 * The StreamHandler sits between the PiConnection (which emits raw RPC events)
 * and the view layer (which renders ChatMessages). It accumulates text deltas,
 * tracks tool calls, and fires callbacks that the view can use to update the UI.
 *
 * Key design: onMessageUpdate fires on every text delta with the FULL accumulated
 * text so far. The view re-renders markdown from scratch each time — Obsidian's
 * MarkdownRenderer is fast enough for this approach.
 */

import { ChatMessage, generateMessageId } from "./message-types";

export interface StreamCallbacks {
    onMessageUpdate: (msg: ChatMessage) => void;
    onMessageComplete: (msg: ChatMessage) => void;
    onToolResult: (msg: ChatMessage) => void;
    onToolExecutionStart?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void;
    onToolExecutionUpdate?: (toolCallId: string, toolName: string, partialResult: string) => void;
    onCompaction?: () => void;
    onError?: (error: string) => void;
}

export class StreamHandler {
    private currentMessage: ChatMessage | null = null;
    private currentText = '';
    private currentThinking = '';
    private callbacks: StreamCallbacks;

    // Track tool calls the model is generating (from message_update toolcall events)
    private pendingToolCalls: Map<string, { name: string; arguments: string }> = new Map();

    constructor(callbacks: StreamCallbacks) {
        this.callbacks = callbacks;
    }

    /**
     * Process a single RPC event from PiConnection.
     * Call this for every event received via PiConnection.onEvent().
     */
    handleEvent(event: Record<string, unknown>): void {
        const type = event.type as string;

        switch (type) {
            case 'message_start':
                this.handleMessageStart(event);
                break;
            case 'message_update':
                this.handleMessageUpdate(event);
                break;
            case 'message_end':
                this.handleMessageEnd(event);
                break;
            case 'tool_execution_start':
                this.handleToolExecutionStart(event);
                break;
            case 'tool_execution_update':
                this.handleToolExecutionUpdate(event);
                break;
            case 'tool_execution_end':
                this.handleToolExecutionEnd(event);
                break;
            case 'auto_compaction_end':
                if (this.callbacks.onCompaction) {
                    this.callbacks.onCompaction();
                }
                break;
            case 'error':
                if (this.callbacks.onError) {
                    this.callbacks.onError(String(event.error || 'Unknown error'));
                }
                break;
        }
    }

    /**
     * Get the current in-progress message, if any.
     */
    getCurrentMessage(): ChatMessage | null {
        return this.currentMessage ? { ...this.currentMessage } : null;
    }

    /**
     * Check if we're currently streaming a message.
     */
    isStreaming(): boolean {
        return this.currentMessage !== null && (this.currentMessage.isStreaming ?? false);
    }

    /**
     * Reset streaming state. Call this when aborting or starting a new session.
     */
    reset(): void {
        this.currentMessage = null;
        this.currentText = '';
        this.currentThinking = '';
        this.pendingToolCalls.clear();
    }

    // --- Event handlers ---

    private handleMessageStart(event: Record<string, unknown>): void {
        // Reset accumulators for the new message
        this.currentText = '';
        this.currentThinking = '';
        this.pendingToolCalls.clear();

        this.currentMessage = {
            id: generateMessageId(),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            isStreaming: true,
        };

        // Fire initial update so the view can show a streaming placeholder
        this.callbacks.onMessageUpdate(this.buildCurrentMessage());
    }

    private handleMessageUpdate(event: Record<string, unknown>): void {
        if (!this.currentMessage) return;

        const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (!ame) return;

        const deltaType = ame.type as string;

        switch (deltaType) {
            case 'text_delta': {
                const delta = ame.delta as string;
                if (delta) {
                    this.currentText += delta;
                    // Fire update with full accumulated text
                    this.callbacks.onMessageUpdate(this.buildCurrentMessage());
                }
                break;
            }
            case 'thinking_delta': {
                const delta = ame.delta as string;
                if (delta) {
                    this.currentThinking += delta;
                    // Update with thinking content — view can show a thinking indicator
                    this.callbacks.onMessageUpdate(this.buildCurrentMessage());
                }
                break;
            }
            case 'toolcall_start': {
                // The model is generating a tool call. Track it by contentIndex.
                const contentIndex = String(ame.contentIndex ?? '');
                const partial = ame.partial as Record<string, unknown> | undefined;
                const toolName = (partial?.name as string) ?? '';
                this.pendingToolCalls.set(contentIndex, { name: toolName, arguments: '' });
                break;
            }
            case 'toolcall_delta': {
                // Accumulate tool call arguments
                const contentIndex = String(ame.contentIndex ?? '');
                const delta = ame.delta as string;
                const pending = this.pendingToolCalls.get(contentIndex);
                if (pending && delta) {
                    pending.arguments += delta;
                }
                break;
            }
            case 'toolcall_end': {
                // Tool call generation complete. The full toolCall object is in the event.
                // We don't create a ChatMessage here — that happens at tool_execution_end.
                const contentIndex = String(ame.contentIndex ?? '');
                const toolCall = ame.toolCall as Record<string, unknown> | undefined;
                if (toolCall) {
                    const name = (toolCall.name as string) ?? '';
                    this.pendingToolCalls.set(contentIndex, {
                        name,
                        arguments: JSON.stringify(toolCall.arguments ?? {}),
                    });
                }
                break;
            }
            case 'done': {
                // assistantMessageEvent done with reason. Normal completion reasons
                // are "stop", "length", "toolUse" — none of these are errors.
                // We handle finalization in message_end.
                break;
            }
            case 'error': {
                // Error during streaming — set error state on the message
                const reason = ame.reason as string | undefined;
                if (this.currentMessage) {
                    this.currentMessage.isError = true;
                    if (reason === 'aborted') {
                        this.currentText += '\n\n*[Aborted]*';
                    } else {
                        this.currentText += '\n\n*[Error]*';
                    }
                    this.currentMessage.isStreaming = false;
                    this.currentMessage.content = this.currentText;
                    this.currentMessage.thinkingContent = this.currentThinking || undefined;
                    this.callbacks.onMessageComplete(this.buildCurrentMessage());
                    this.currentMessage = null;
                }
                break;
            }
            // text_start, text_end, thinking_start, thinking_end, start:
            // No action needed — we accumulate via deltas
        }
    }

    private handleMessageEnd(_event: Record<string, unknown>): void {
        if (!this.currentMessage) return;

        // Finalize the message
        this.currentMessage.isStreaming = false;
        this.currentMessage.content = this.currentText;
        this.currentMessage.thinkingContent = this.currentThinking || undefined;

        this.callbacks.onMessageComplete(this.buildCurrentMessage());
        this.currentMessage = null;
    }

    private handleToolExecutionStart(event: Record<string, unknown>): void {
        const toolCallId = event.toolCallId as string;
        const toolName = event.toolName as string;
        const args = (event.args as Record<string, unknown>) ?? {};

        if (this.callbacks.onToolExecutionStart) {
            this.callbacks.onToolExecutionStart(toolCallId, toolName, args);
        }
    }

    private handleToolExecutionUpdate(event: Record<string, unknown>): void {
        const toolCallId = event.toolCallId as string;
        const toolName = event.toolName as string;

        // partialResult.content is an array of {type: "text", text: "..."} blocks
        const partialResult = event.partialResult as Record<string, unknown> | undefined;
        const resultText = this.extractResultText(partialResult);

        if (this.callbacks.onToolExecutionUpdate) {
            this.callbacks.onToolExecutionUpdate(toolCallId, toolName, resultText);
        }
    }

    private handleToolExecutionEnd(event: Record<string, unknown>): void {
        const toolCallId = event.toolCallId as string;
        const toolName = event.toolName as string;
        const isError = (event.isError as boolean) ?? false;

        // Extract result text from content blocks
        const result = event.result as Record<string, unknown> | undefined;
        const resultText = this.extractResultText(result);

        const toolMessage: ChatMessage = {
            id: generateMessageId(),
            role: 'tool',
            content: resultText,
            timestamp: Date.now(),
            toolName: toolName,
            toolCallId: toolCallId,
            isError: isError || undefined,
        };

        this.callbacks.onToolResult(toolMessage);
    }

    // --- Helpers ---

    /**
     * Build a snapshot of the current message with accumulated text.
     * Returns a copy so the view can safely store it.
     */
    private buildCurrentMessage(): ChatMessage {
        return {
            ...this.currentMessage!,
            content: this.currentText,
            thinkingContent: this.currentThinking || undefined,
        };
    }

    /**
     * Extract text from a result/partialResult object.
     * Result content is an array of {type: "text", text: "..."} blocks.
     */
    private extractResultText(result: Record<string, unknown> | undefined): string {
        if (!result) return '';

        const content = result.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) return '';

        return content
            .filter((block) => block.type === 'text')
            .map((block) => block.text as string)
            .join('');
    }
}
