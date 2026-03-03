/**
 * Scans Pi's native session directory (~/.pi/agent/sessions/) for session metadata.
 *
 * Pi stores sessions as .jsonl files. We read the first and last lines to extract
 * metadata (name, date, cwd, message count) without loading the full file.
 *
 * Session directory structure:
 *   ~/.pi/agent/sessions/<cwd-slug>/<session-name>.jsonl
 */

import { readFile, readdir, stat } from "fs/promises";
import { join, basename, dirname } from "path";
import { homedir } from "os";

export interface PiSession {
    /** Full path to the .jsonl file */
    path: string;
    /** Session display name (from metadata or filename) */
    name: string;
    /** Working directory this session was started in */
    cwd: string;
    /** Last modified time (ms since epoch) */
    mtime: number;
    /** Approximate message count (line count / 2 as rough heuristic) */
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
     * Only reads first and last lines to avoid loading the full file.
     */
    private async readSessionMetadata(filePath: string, cwdSlug: string): Promise<PiSession | null> {
        const fileStat = await stat(filePath);
        if (fileStat.size === 0) return null;

        // Read the full file — for most sessions this is fine.
        // For very large sessions (>1MB), we could optimize with streams,
        // but that's premature for now.
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());

        if (lines.length === 0) return null;

        // Try to parse first line for session metadata
        let name = basename(filePath, ".jsonl");
        let preview = "";
        let cwd = this.unslugCwd(cwdSlug);

        // Look for the session name in metadata or first user message
        for (const line of lines.slice(0, 10)) {
            try {
                const entry = JSON.parse(line);
                // Check for session metadata entry
                if (entry.sessionName) {
                    name = entry.sessionName;
                }
                if (entry.cwd) {
                    cwd = entry.cwd;
                }
                // Find first user message for preview
                if (!preview && entry.role === "user" && entry.content) {
                    const text = typeof entry.content === "string"
                        ? entry.content
                        : Array.isArray(entry.content)
                            ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
                            : "";
                    if (text) {
                        preview = text.length > 80 ? text.slice(0, 80) + "…" : text;
                    }
                }
            } catch {
                // Skip malformed lines
            }
        }

        // Estimate message count: each user+assistant pair is roughly 2 lines
        // but there are also tool calls, metadata, etc.
        const messageCount = Math.max(1, Math.floor(lines.length / 2));

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
     * Convert a cwd slug back to a readable path.
     * Pi slugs directories by replacing / with - and other transformations.
     * We just display the slug directly — it's readable enough.
     */
    private unslugCwd(slug: string): string {
        // Common pattern: home-username-Projects-... → ~/Projects/...
        const home = basename(homedir());
        if (slug.startsWith(`home-${home}-`)) {
            return "~/" + slug.slice(`home-${home}-`.length).replace(/-/g, "/");
        }
        return slug.replace(/-/g, "/");
    }
}
