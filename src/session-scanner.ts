/**
 * Scans Pi's native session directory (~/.pi/agent/sessions/) for session metadata.
 *
 * Pi stores sessions as .jsonl files. Each line is a typed entry:
 *   - { type: "session", id, cwd, timestamp }       — session metadata (first line)
 *   - { type: "model_change", provider, modelId }    — model switch
 *   - { type: "message", message: { role, content }} — user/assistant/toolResult message
 *   - { type: "session_name", name }                 — display name
 *
 * Session directory structure:
 *   ~/.pi/agent/sessions/--<slug>--/<timestamp>_<uuid>.jsonl
 *
 * Slugs use -- as boundary delimiters and - within path components:
 *   /home/user/Projects → --home-user-Projects--
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

export interface PiSession {
    /** Full path to the .jsonl file */
    path: string;
    /** Session display name (from session_name entry or filename) */
    name: string;
    /** Working directory this session was started in */
    cwd: string;
    /** Last modified time (ms since epoch) */
    mtime: number;
    /** Approximate message count */
    messageCount: number;
    /** First user message as preview text */
    preview: string;
}

export class SessionScanner {
    private sessionsDir: string;

    constructor(sessionsDir?: string) {
        this.sessionsDir = sessionsDir || join(homedir(), ".pi", "agent", "sessions");
    }

    /**
     * Scan the sessions directory and return metadata for all sessions,
     * sorted by most recent first.
     */
    async scan(): Promise<PiSession[]> {
        const sessions: PiSession[] = [];

        let cwdDirs: string[];
        try {
            cwdDirs = await readdir(this.sessionsDir);
        } catch {
            // Directory doesn't exist — no sessions
            return [];
        }

        for (const cwdSlug of cwdDirs) {
            const cwdPath = join(this.sessionsDir, cwdSlug);
            try {
                const cwdStat = await stat(cwdPath);
                if (!cwdStat.isDirectory()) continue;
            } catch {
                continue;
            }

            let files: string[];
            try {
                files = await readdir(cwdPath);
            } catch {
                continue;
            }

            for (const file of files) {
                if (!file.endsWith(".jsonl")) continue;
                const filePath = join(cwdPath, file);
                try {
                    const session = await this.readSessionMetadata(filePath, cwdSlug);
                    if (session) sessions.push(session);
                } catch (err) {
                    console.warn(`[SessionScanner] Failed to read ${filePath}:`, err);
                }
            }
        }

        // Sort most recent first
        sessions.sort((a, b) => b.mtime - a.mtime);
        return sessions;
    }

    /**
     * Read metadata from a single .jsonl session file.
     */
    private async readSessionMetadata(filePath: string, cwdSlug: string): Promise<PiSession | null> {
        const fileStat = await stat(filePath);
        if (fileStat.size === 0) return null;

        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());

        if (lines.length === 0) return null;

        let name = basename(filePath, ".jsonl");
        let preview = "";
        let cwd = this.unslugCwd(cwdSlug);
        let messageCount = 0;
        let sessionName = "";

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);

                // Session header — first line
                if (entry.type === "session") {
                    if (entry.cwd) cwd = entry.cwd;
                    if (entry.id) name = entry.id;
                    continue;
                }

                // Session name set by user
                if (entry.type === "session_name" && entry.name) {
                    sessionName = entry.name;
                    continue;
                }

                // Message entry — count and extract preview
                if (entry.type === "message" && entry.message) {
                    const msg = entry.message;

                    if (msg.role === "user" || msg.role === "assistant") {
                        messageCount++;
                    }

                    // First user message as preview
                    if (!preview && msg.role === "user") {
                        preview = this.extractText(msg.content);
                        if (preview.length > 80) {
                            preview = preview.slice(0, 80) + "…";
                        }
                    }
                }
            } catch {
                // Skip malformed lines
            }
        }

        // Use session name if set, otherwise derive from timestamp in filename
        if (sessionName) {
            name = sessionName;
        } else {
            // Filename format: 2026-03-03T10-44-51-584Z_uuid.jsonl
            const dateMatch = basename(filePath).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
            if (dateMatch) {
                name = `${dateMatch[1]} ${dateMatch[2]}:${dateMatch[3]}`;
            }
        }

        return {
            path: filePath,
            name,
            cwd,
            mtime: fileStat.mtimeMs,
            messageCount,
            preview: preview || "(empty session)",
        };
    }

    /**
     * Extract plain text from a message content field.
     * Content can be a string or an array of content blocks.
     */
    private extractText(content: unknown): string {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content
                .filter((b: any) => b.type === "text" && b.text)
                .map((b: any) => b.text)
                .join(" ");
        }
        return "";
    }

    /**
     * Convert a cwd slug back to a readable path.
     * Pi slugs: --home-user-Projects-- → /home/user/Projects
     */
    private unslugCwd(slug: string): string {
        // Strip leading/trailing --
        let inner = slug;
        if (inner.startsWith("--")) inner = inner.slice(2);
        if (inner.endsWith("--")) inner = inner.slice(0, -2);

        // Replace - with /
        const path = "/" + inner.replace(/-/g, "/");

        return path;
    }
}
