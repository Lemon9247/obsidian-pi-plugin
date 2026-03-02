import { App, Component, MarkdownRenderer } from "obsidian";

/**
 * Renders chat messages using Obsidian's native MarkdownRenderer.
 * This gives us Mermaid diagrams, wiki-links, callouts, code highlighting, etc.
 */
export class MessageRenderer {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Render an assistant message as Obsidian-flavored markdown.
     * Returns the wrapper element for use by streaming logic.
     */
    renderAssistantMessage(
        container: HTMLElement,
        markdown: string,
        sourcePath: string,
        component: Component,
    ): HTMLElement {
        const wrapper = container.createDiv({ cls: "pi-message pi-message-assistant" });
        const label = wrapper.createDiv({ cls: "pi-message-label" });
        label.createSpan({ text: "Pi", cls: "pi-message-label-text" });

        const contentEl = wrapper.createDiv({ cls: "pi-message-content" });

        if (markdown) {
            try {
                MarkdownRenderer.render(this.app, markdown, contentEl, sourcePath, component);
            } catch (err) {
                console.error("[Pi Chat] Markdown rendering error:", err);
                contentEl.setText(markdown);
            }
        }

        return wrapper;
    }

    /**
     * Render a user message in a styled container.
     */
    renderUserMessage(container: HTMLElement, text: string): HTMLElement {
        const wrapper = container.createDiv({ cls: "pi-message pi-message-user" });
        const label = wrapper.createDiv({ cls: "pi-message-label" });
        label.createSpan({ text: "You", cls: "pi-message-label-text" });

        const contentEl = wrapper.createDiv({ cls: "pi-message-content" });
        contentEl.createEl("p", { text });

        return wrapper;
    }

    /**
     * Render a tool call/result in a collapsible <details> element.
     * Shows the tool name in the summary, with args and result inside.
     */
    renderToolCall(
        container: HTMLElement,
        toolName: string,
        args: string,
        result: string,
        isError: boolean,
        component: Component,
    ): HTMLElement {
        const wrapper = container.createDiv({
            cls: `pi-message pi-message-tool${isError ? " pi-message-tool-error" : ""}`,
        });

        const details = wrapper.createEl("details");
        const summary = details.createEl("summary");
        summary.createSpan({ text: `⚙ ${toolName}`, cls: "pi-tool-name" });

        if (isError) {
            summary.createSpan({ text: " ✗", cls: "pi-tool-error-indicator" });
        }

        const body = details.createDiv({ cls: "pi-tool-body" });

        // Render args if present
        if (args) {
            const argsSection = body.createDiv({ cls: "pi-tool-args" });
            argsSection.createEl("div", { text: "Arguments", cls: "pi-tool-section-label" });
            const argsCode = argsSection.createEl("pre");
            argsCode.createEl("code", { text: args });
        }

        // Render result — use markdown rendering for rich content
        if (result) {
            const resultSection = body.createDiv({ cls: "pi-tool-result" });
            resultSection.createEl("div", { text: "Result", cls: "pi-tool-section-label" });

            const resultContent = resultSection.createDiv({ cls: "pi-tool-result-content" });

            // If result looks like it contains code or markdown, render it
            if (this.looksLikeMarkdown(result)) {
                try {
                    MarkdownRenderer.render(
                        this.app,
                        result,
                        resultContent,
                        "",
                        component,
                    );
                } catch (err) {
                    console.error("[Pi Chat] Tool result render error:", err);
                    const pre = resultContent.createEl("pre");
                    pre.createEl("code", { text: result });
                }
            } else {
                const pre = resultContent.createEl("pre");
                pre.createEl("code", { text: result });
            }
        }

        return wrapper;
    }

    /**
     * Simple heuristic to detect if content contains markdown.
     * Falls back to code block rendering for plain text.
     */
    private looksLikeMarkdown(text: string): boolean {
        return /```|^#{1,6}\s|^\s*[-*]\s|\[.*\]\(|\!\[|> |^\|.*\|/m.test(text);
    }
}
