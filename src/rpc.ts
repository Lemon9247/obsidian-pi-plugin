import { ChildProcess, spawn } from "child_process";
import { createInterface, Interface as ReadlineInterface } from "readline";

export type EventHandler = (event: Record<string, unknown>) => void;

/**
 * Manages a connection to Pi's RPC interface.
 * Spawns `pi --mode rpc --no-session` and communicates via JSON lines over stdin/stdout.
 */
export class PiConnection {
    private piBinaryPath: string;
    private cwd: string;
    private extraArgs: string[];
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private handlers: EventHandler[] = [];
    private connected = false;

    constructor(piBinaryPath: string, cwd: string, extraArgs: string[] = []) {
        this.piBinaryPath = piBinaryPath;
        this.cwd = cwd;
        this.extraArgs = extraArgs;
    }

    /**
     * Spawn the Pi process and set up JSON line parsing on stdout.
     */
    connect(): void {
        if (this.process) {
            this.destroy();
        }

        this.process = spawn(this.piBinaryPath, ["--mode", "rpc", "--no-session", ...this.extraArgs], {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });

        this.connected = true;

        // Parse JSON lines from stdout
        if (this.process.stdout) {
            this.readline = createInterface({
                input: this.process.stdout,
                crlfDelay: Infinity,
            });

            this.readline.on("line", (line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                try {
                    const event = JSON.parse(trimmed) as Record<string, unknown>;
                    this.dispatch(event);
                } catch (err) {
                    // Non-JSON output — ignore (Pi may emit debug text)
                    console.warn("[Pi RPC] Non-JSON line from stdout:", trimmed);
                }
            });
        }

        // Log stderr for debugging
        if (this.process.stderr) {
            this.process.stderr.on("data", (data: Buffer) => {
                console.warn("[Pi RPC] stderr:", data.toString());
            });
        }

        // Handle process exit
        this.process.on("exit", (code: number | null, signal: string | null) => {
            this.connected = false;
            this.dispatch({
                type: "error",
                error: `Pi process exited (code=${code}, signal=${signal})`,
            });
            this.cleanup();
        });

        this.process.on("error", (err: Error) => {
            this.connected = false;
            this.dispatch({
                type: "error",
                error: `Pi process error: ${err.message}`,
            });
            this.cleanup();
        });
    }

    /**
     * Send a command to Pi via stdin as a JSON line.
     */
    send(command: Record<string, unknown>): void {
        if (!this.process || !this.process.stdin || !this.connected) {
            throw new Error("Pi is not connected");
        }

        const line = JSON.stringify(command) + "\n";
        this.process.stdin.write(line);
    }

    /**
     * Register a handler for events received from Pi.
     * Each JSON line parsed from stdout is dispatched to all handlers.
     */
    onEvent(handler: EventHandler): void {
        this.handlers.push(handler);
    }

    /**
     * Remove a previously registered event handler.
     */
    offEvent(handler: EventHandler): void {
        const idx = this.handlers.indexOf(handler);
        if (idx !== -1) {
            this.handlers.splice(idx, 1);
        }
    }

    /**
     * Kill the child process and clean up.
     */
    destroy(): void {
        if (this.process) {
            this.process.kill();
        }
        this.cleanup();
    }

    /**
     * Check if the Pi process is alive.
     */
    isConnected(): boolean {
        return this.connected;
    }

    private dispatch(event: Record<string, unknown>): void {
        for (const handler of this.handlers) {
            try {
                handler(event);
            } catch (err) {
                console.error("[Pi RPC] Handler error:", err);
            }
        }
    }

    private cleanup(): void {
        this.connected = false;
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
        this.process = null;
    }
}
