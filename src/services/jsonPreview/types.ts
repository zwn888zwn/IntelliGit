export const JSON_PAGE_LINES = 1000;
export const JSON_LINE_CHARS = 2000;
export type JsonPart = { text: string; kind: "key" | "string" | "number" | "literal" | "punctuation" };
export type JsonLine = { number: number; depth: number; continued: boolean; parts: JsonPart[] };
export type JsonPage = { index: number; lines: JsonLine[]; done: boolean; error?: string };
export type JsonPreviewMessage =
    | { type: "reset"; generation: number; name: string; size: number }
    | { type: "page"; generation: number; page: JsonPage; bytesRead: number; formattedLines: number }
    | { type: "error"; generation: number; message: string };

export type JsonNodeKind = "object" | "array" | "string" | "number" | "literal";
export type JsonTreeNode = { offset: number; kind: JsonNodeKind; label: string; ordinal?: number; preview: string; truncated: boolean };
// The last value is skipped only when another page is requested. This lets a
// page end at a huge child without first walking that child's entire contents.
export type JsonTreeCursor = { offset: number; ordinal: number };
export type JsonTreeMessage =
    | { type: "reset"; generation: number; name: string; size: number }
    | { type: "root"; generation: number; node: JsonTreeNode }
    | { type: "children"; generation: number; parent: number; request: number; nodes: JsonTreeNode[]; complete: boolean; next?: JsonTreeCursor; error?: string }
    | { type: "value"; generation: number; offset: number; text: string; truncated: boolean }
    | { type: "error"; generation: number; message: string };
