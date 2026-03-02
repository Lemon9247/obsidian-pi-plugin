/**
 * Session persistence — save/load conversations as markdown notes.
 *
 * Conversations are saved as Obsidian-friendly markdown with:
 * - YAML frontmatter (pi-session: true, model, created)
 * - User messages as > [!user] callouts
 * - Assistant messages as raw markdown
 * - Tool calls as > [!tool]- collapsed callouts
 *
 * These are a browsable VIEW only. Pi stores raw session data as .jsonl
 * in ~/.pi/agent/sessions/. The markdown is for reading in Obsidian,
 * not round-tripping.
 */

import { Vault } from "obsidian";
import type { ChatMessage } from "./message-types";
import { generateMessageId } from "./message-types";
import type { PiPluginSettings } from "./settings";

export class SessionManager {

    /**
     * Save a conversation as a markdown note in the vault.
     * Returns the vault-relative path of the saved file, or null if skipped.
     */
    async saveSession(
        messages: ChatMessage[],
        settings: PiPluginSettings,
        vault: Vault,
    ): Promise<string | null> {
        if (!settings.persistSessions) return null;

        // Skip if no assistant messages (empty or user-only conversation)
        if (!messages.some((m) => m.role === "assistant")) {
            return null;
        }

        const markdown = this.formatConversation(messages, settings);
        const filePath = this.generateFilePath(settings);

        await this.ensureDirectory(settings.sessionSaveDir, vault);

        // Retry with random suffix on collision (avoids TOCTOU race
        // where two concurrent saves could both pass an exists() check)
        const maxAttempts = 5;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const targetPath = attempt === 0
                ? filePath
                : `${filePath.replace(/\.md$/, "")}-${Math.random().toString(36).slice(2, 6)}.md`;
            try {
                await vault.create(targetPath, markdown);
                return targetPath;
            } catch (err) {
                if (err instanceof Error && err.message.includes("already exists")) {
                    if (attempt >= maxAttempts - 1) {
                        throw new Error(`Failed to save session after ${maxAttempts} attempts: file collision`);
                    }
                    continue;
                }
                throw err; // Re-throw non-collision errors
            }
        }

        return null; // Unreachable, satisfies TypeScript
    }

    /**
     * Load a saved session from a markdown note.
     * Parses callout blocks back into ChatMessage array.
     */
    async loadSession(path: string, vault: Vault): Promise<ChatMessage[]> {
        const content = await vault.adapter.read(path);
        return this.parseConversation(content);
    }

    /**
     * Format messages as Obsidian-friendly markdown.
     */
    formatConversation(messages: ChatMessage[], settings: PiPluginSettings): string {
        const now = new Date().toISOString();
        const model = settings.defaultModel || "unknown";

        let md = "";
        md += "---\n";
        md += "pi-session: true\n";
        md += `model: ${model}\n`;
        md += `created: ${now}\n`;
        md += "---\n\n";

        for (const msg of messages) {
            switch (msg.role) {
                case "user":
                    md += this.formatUserMessage(msg);
                    break;
                case "assistant":
                    md += this.formatAssistantMessage(msg);
                    break;
                case "tool":
                    md += this.formatToolMessage(msg);
                    break;
            }
        }

        return md;
    }

    /**
     * Parse markdown content back into ChatMessage array.
     */
    parseConversation(content: string): ChatMessage[] {
        const body = this.stripFrontmatter(content);
        const lines = body.split("\n");
        const messages: ChatMessage[] = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (line.startsWith("> [!user]")) {
                // User message callout
                i++;
                const contentLines: string[] = [];
                while (i < lines.length && lines[i].startsWith(">")) {
                    // Strip "> " or ">" prefix, then unescape callout markers
                    const stripped = lines[i].startsWith("> ")
                        ? lines[i].slice(2)
                        : lines[i].slice(1);
                    contentLines.push(this.unescapeCalloutMarker(stripped));
                    i++;
                }
                // Warn if callout ended unexpectedly (missing > prefix)
                if (i < lines.length && lines[i].trim() !== "" &&
                    !lines[i].startsWith("> [!")) {
                    console.warn(`[Session Parser] Malformed user callout at line ${i + 1}: expected > prefix or blank line`);
                }
                messages.push({
                    id: generateMessageId(),
                    role: "user",
                    content: contentLines.join("\n"),
                    timestamp: 0,
                });
            } else if (line.startsWith("> [!tool]")) {
                // Tool message callout — parse tool name from header
                const toolName = this.parseToolName(line);
                i++;
                const contentLines: string[] = [];
                while (i < lines.length && lines[i].startsWith(">")) {
                    const stripped = lines[i].startsWith("> ")
                        ? lines[i].slice(2)
                        : lines[i].slice(1);
                    contentLines.push(this.unescapeCalloutMarker(stripped));
                    i++;
                }
                // Warn if callout ended unexpectedly (missing > prefix)
                if (i < lines.length && lines[i].trim() !== "" &&
                    !lines[i].startsWith("> [!")) {
                    console.warn(`[Session Parser] Malformed tool callout at line ${i + 1}: expected > prefix or blank line`);
                }
                messages.push({
                    id: generateMessageId(),
                    role: "tool",
                    content: contentLines.join("\n"),
                    timestamp: 0,
                    toolName,
                });
            } else if (line.trim() === "") {
                // Skip blank lines between messages
                i++;
            } else {
                // Assistant message — collect until next callout or EOF
                const contentLines: string[] = [];
                while (
                    i < lines.length &&
                    !lines[i].startsWith("> [!user]") &&
                    !lines[i].startsWith("> [!tool]")
                ) {
                    contentLines.push(lines[i]);
                    i++;
                }
                // Trim trailing blank lines
                while (
                    contentLines.length > 0 &&
                    contentLines[contentLines.length - 1].trim() === ""
                ) {
                    contentLines.pop();
                }
                if (contentLines.length > 0) {
                    messages.push({
                        id: generateMessageId(),
                        role: "assistant",
                        content: contentLines.join("\n"),
                        timestamp: 0,
                    });
                }
            }
        }

        return messages;
    }

    // --- Formatting helpers ---

    private formatUserMessage(msg: ChatMessage): string {
        const lines = msg.content.split("\n");
        const calloutBody = lines.map((l) => `> ${this.escapeCalloutMarker(l)}`).join("\n");
        return `> [!user]\n${calloutBody}\n\n`;
    }

    private formatAssistantMessage(msg: ChatMessage): string {
        return `${msg.content}\n\n`;
    }

    private formatToolMessage(msg: ChatMessage): string {
        const name = msg.toolName || "tool";
        const lines = msg.content.split("\n");
        const calloutBody = lines.map((l) => `> ${this.escapeCalloutMarker(l)}`).join("\n");
        // Collapsed callout (- after type) keeps tool output folded by default
        return `> [!tool]- ${name}\n${calloutBody}\n\n`;
    }

    private generateFilePath(settings: PiPluginSettings): string {
        const dir = this.normalizeDir(settings.sessionSaveDir);
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const filename = [
            now.getFullYear(),
            pad(now.getMonth() + 1),
            pad(now.getDate()),
            pad(now.getHours()),
            pad(now.getMinutes()),
        ].join("-") + ".md";
        return `${dir}/${filename}`;
    }

    private async ensureDirectory(dir: string, vault: Vault): Promise<void> {
        const normalized = this.normalizeDir(dir);
        if (!(await vault.adapter.exists(normalized))) {
            await vault.createFolder(normalized);
        }
    }

    /**
     * Normalize a vault-relative directory path: strip leading/trailing
     * slashes and fall back to a default if empty.
     */
    private normalizeDir(dir: string): string {
        return dir.replace(/^\/+|\/+$/g, "") || "Pi-Sessions";
    }

    private stripFrontmatter(content: string): string {
        if (!content.startsWith("---")) return content;
        const endIdx = content.indexOf("---", 3);
        if (endIdx < 0) return content;
        return content.slice(endIdx + 3).trim();
    }

    /**
     * Parse tool name from callout header line.
     * Handles: "> [!tool]- bash" and "> [!tool]- bash: `ls src/`"
     */
    private parseToolName(line: string): string {
        const match = line.match(/> \[!tool\]-?\s*(\S+)/);
        if (match) {
            // Strip trailing colon if present
            return match[1].replace(/:$/, "");
        }
        return "tool";
    }

    /**
     * Escape lines that start with [! so they won't be parsed as callout
     * boundaries when the content is reloaded. Uses \[! which is visible
     * but unambiguous.
     */
    private escapeCalloutMarker(line: string): string {
        if (line.startsWith("[!")) {
            return "\\" + line;
        }
        return line;
    }

    /**
     * Reverse the escaping applied by escapeCalloutMarker.
     */
    private unescapeCalloutMarker(line: string): string {
        if (line.startsWith("\\[!")) {
            return line.slice(1);
        }
        return line;
    }
}
