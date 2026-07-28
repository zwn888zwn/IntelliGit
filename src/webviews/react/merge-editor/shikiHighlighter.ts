// Grammar-accurate syntax highlighting for the merge editor webview.
// The JavaScript regex engine is CSP-safe and avoids a WASM runtime.

import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import js from "@shikijs/langs/javascript";
import ts from "@shikijs/langs/typescript";
import jsx from "@shikijs/langs/jsx";
import tsx from "@shikijs/langs/tsx";
import json from "@shikijs/langs/json";
import python from "@shikijs/langs/python";
import go from "@shikijs/langs/go";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import yaml from "@shikijs/langs/yaml";
import shell from "@shikijs/langs/shell";
import markdown from "@shikijs/langs/markdown";

import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";

export type ShikiTheme = "dark-plus" | "light-plus";

export interface ShikiToken {
    text: string;
    color?: string;
    fontStyle?: number;
}

const extensionMap: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    json: "json",
    py: "python",
    go: "go",
    css: "css",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
    sh: "shell",
    bash: "shell",
    md: "markdown",
};

let highlighter: ReturnType<typeof createHighlighterCoreSync> | null = null;
let highlighterReady = false;

const tokenCache = new Map<string, ShikiToken[] | null>();
const CACHE_MAX = 5000;

export function detectTheme(): ShikiTheme {
    if (typeof document === "undefined") return "light-plus";
    const classes = document.body.classList;
    if (classes.contains("vscode-dark") || classes.contains("vscode-high-contrast")) {
        return "dark-plus";
    }
    return "light-plus";
}

export function langForPath(filePath: string): string | null {
    const lastDot = filePath.lastIndexOf(".");
    if (lastDot === -1 || lastDot === filePath.length - 1) return null;
    return extensionMap[filePath.substring(lastDot + 1).toLowerCase()] ?? null;
}

export function initShiki(): boolean {
    if (highlighterReady) return false;
    try {
        highlighter = createHighlighterCoreSync({
            langs: [js, ts, jsx, tsx, json, python, go, css, html, yaml, shell, markdown],
            themes: [darkPlus, lightPlus],
            engine: createJavaScriptRegexEngine({ forgiving: true }),
        });
        highlighterReady = true;
        return true;
    } catch (error) {
        console.error("Failed to initialize Shiki:", error);
        return false;
    }
}

export function isShikiReady(): boolean {
    return highlighterReady && highlighter !== null;
}

export function highlightLine(line: string, lang: string, theme: ShikiTheme): ShikiToken[] | null {
    if (!isShikiReady() || !highlighter) return null;

    const cacheKey = `${line}|${lang}|${theme}`;
    if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey) ?? null;

    try {
        const lines = highlighter.codeToTokensBase(line, { lang, theme });
        if (!lines?.length) {
            tokenCache.set(cacheKey, null);
            return null;
        }
        const tokens = lines[0].map((token) => ({
            text: token.content,
            color: token.color,
            fontStyle: token.fontStyle,
        }));
        if (tokenCache.size >= CACHE_MAX) {
            const firstKey = tokenCache.keys().next().value;
            if (firstKey) tokenCache.delete(firstKey);
        }
        tokenCache.set(cacheKey, tokens);
        return tokens;
    } catch (error) {
        console.warn(`Failed to highlight line with lang="${lang}":`, error);
        tokenCache.set(cacheKey, null);
        return null;
    }
}
