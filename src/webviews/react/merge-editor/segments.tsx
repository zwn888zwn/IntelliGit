// Merge editor segment rendering components.
// CommonSection renders unchanged code lines across all three panes.
// ConflictSection renders conflict hunks with per-hunk resolution controls.
// OverviewRail provides a minimap of conflict locations for quick navigation.

import React, { useCallback, useMemo, useRef, useState } from "react";
import type { CommonSegment, ConflictSegment, HunkResolution } from "./types";
import {
    IconArrowRight,
    IconArrowLeft,
    IconClose,
    IconSplitBoth,
    IconWarning,
    IconCheck,
    IconDot,
} from "./icons";
import {
    tokenSimilarityRatio,
    buildWordDiffMask,
    tokenizeWordDiff,
    alignCompareLinesForWordDiff,
} from "./wordDiff";

// --- Syntax highlighting ---

const KEYWORDS = new Set([
    "async",
    "await",
    "break",
    "case",
    "chan",
    "class",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "export",
    "fallthrough",
    "for",
    "from",
    "func",
    "function",
    "go",
    "goto",
    "if",
    "import",
    "interface",
    "let",
    "map",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "range",
    "readonly",
    "return",
    "select",
    "static",
    "struct",
    "switch",
    "type",
    "var",
]);
const BUILTIN_TYPES = new Set([
    "any",
    "bool",
    "byte",
    "complex64",
    "complex128",
    "error",
    "float32",
    "float64",
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "rune",
    "string",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uintptr",
]);
const CONSTANTS = new Set(["false", "iota", "nil", "null", "true", "undefined"]);
const TOKEN_REGEX =
    /(\/\/.*$|\/\*.*?\*\/|"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`|\b[A-Za-z_][A-Za-z0-9_]*\b|\b\d+(\.\d+)?\b)/g;
const EDITOR_LINE_HEIGHT_PX = 22;

function renderTextWithVisibleWhitespace(
    text: string,
    keyPrefix: string,
    className?: string,
): React.ReactNode[] {
    if (!text) return [];

    const nodes: React.ReactNode[] = [];
    const whitespaceRegex = /(\t| +)/g;
    let last = 0;
    let idx = 0;

    for (const match of text.matchAll(whitespaceRegex)) {
        const start = match.index ?? 0;
        if (start > last) {
            nodes.push(
                <span key={`${keyPrefix}-txt-${idx++}`} className={className}>
                    {text.slice(last, start)}
                </span>,
            );
        }

        const token = match[0];
        const whitespaceClassName = [className, "editor-whitespace"].filter(Boolean).join(" ");
        const renderedWhitespace =
            token === "\t" ? "→\u00A0\u00A0\u00A0" : token.replace(/ /g, "·");
        nodes.push(
            <span key={`${keyPrefix}-ws-${idx++}`} className={whitespaceClassName}>
                {renderedWhitespace}
            </span>,
        );
        last = start + token.length;
    }

    if (last < text.length) {
        nodes.push(
            <span key={`${keyPrefix}-txt-${idx}`} className={className}>
                {text.slice(last)}
            </span>,
        );
    }

    return nodes;
}

function renderSyntaxHighlightedNodes(line: string, keyPrefix: string): React.ReactNode[] {
    if (!line) return [<React.Fragment key={`${keyPrefix}-nbsp`}>{`\u00A0`}</React.Fragment>];
    if (line.trimStart().startsWith("//")) {
        return renderTextWithVisibleWhitespace(line, `${keyPrefix}-comment`, "tok-comment");
    }

    const nodes: React.ReactNode[] = [];
    let last = 0;
    let idx = 0;

    for (const match of line.matchAll(TOKEN_REGEX)) {
        const start = match.index ?? 0;
        if (start > last) {
            nodes.push(
                ...renderTextWithVisibleWhitespace(
                    line.slice(last, start),
                    `${keyPrefix}-raw-${idx++}`,
                ),
            );
        }
        const token = match[0];
        let className = "tok-identifier";
        if (token.startsWith("//") || token.startsWith("/*")) className = "tok-comment";
        else if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) {
            className = "tok-string";
        } else if (/^\d/.test(token)) className = "tok-number";
        else if (KEYWORDS.has(token)) className = "tok-keyword";
        else if (BUILTIN_TYPES.has(token)) className = "tok-type";
        else if (CONSTANTS.has(token)) className = "tok-constant";
        nodes.push(
            ...renderTextWithVisibleWhitespace(token, `${keyPrefix}-tok-${idx++}`, className),
        );
        last = start + token.length;
    }
    if (last < line.length) {
        nodes.push(
            ...renderTextWithVisibleWhitespace(line.slice(last), `${keyPrefix}-tail-${idx}`),
        );
    }
    return nodes;
}

function HighlightedLine({ line }: { line: string }): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    return <>{renderSyntaxHighlightedNodes(line, "line")}</>;
}

function WordDiffLine({
    line,
    compareLine,
}: {
    line: string;
    compareLine: string;
}): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    if (line === compareLine) return <HighlightedLine line={line} />;
    if (!compareLine) return <HighlightedLine line={line} />;

    const similarity = tokenSimilarityRatio(line, compareLine);
    if (similarity < 0.28) {
        return <HighlightedLine line={line} />;
    }

    const tokens = tokenizeWordDiff(line);
    if (tokens.length === 0) return <>{`\u00A0`}</>;

    const changedMask = buildWordDiffMask(line, compareLine);
    const nodes: React.ReactNode[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const changed = changedMask[i];
        const syntaxNodes = renderSyntaxHighlightedNodes(token, `wd-${i}`);
        if (!changed) {
            nodes.push(<React.Fragment key={`same-${i}`}>{syntaxNodes}</React.Fragment>);
            continue;
        }

        const isWhitespace = /^\s+$/.test(token);
        nodes.push(
            <span
                key={`chg-${i}`}
                className={`word-diff-change ${isWhitespace ? "word-diff-whitespace" : ""}`}
            >
                {syntaxNodes}
            </span>,
        );
    }

    return <>{nodes}</>;
}

// --- Line numbers ---

export type LineNumberValue = number | null;

export interface LineNumberSpec {
    primary: LineNumberValue[];
    secondary?: LineNumberValue[];
}

export function buildLineNumberValues(
    startAt: number,
    actualCount: number,
    rowCount: number,
): LineNumberValue[] {
    const values: LineNumberValue[] = [];
    for (let i = 0; i < rowCount; i++) {
        values.push(i < actualCount ? startAt + i : null);
    }
    return values;
}

function padLines(lines: string[], count: number): string[] {
    const padded = [...lines];
    while (padded.length < count) padded.push("");
    return padded;
}

function LineNumbers({ primary, secondary }: LineNumberSpec) {
    const rowCount = Math.max(primary.length, secondary?.length ?? 0);
    const hasSecondary = Boolean(secondary);

    return (
        <div className={`line-numbers ${hasSecondary ? "has-secondary" : ""}`}>
            {Array.from({ length: rowCount }, (_, i) => (
                <div key={i} className="line-number-row">
                    {hasSecondary ? (
                        <div className="line-number line-number-secondary">
                            {secondary?.[i] ?? ""}
                        </div>
                    ) : null}
                    <div className="line-number line-number-primary">{primary[i] ?? ""}</div>
                </div>
            ))}
        </div>
    );
}

// --- Code block ---

function CodeBlock({
    lines,
    lineCount,
    lineNumbers,
    className,
    wordHighlight,
    compareLines,
    editable,
    onEdit,
    scrollElementRef,
    previewScrollElementRef,
    onHorizontalScroll,
}: {
    lines: string[];
    lineCount: number;
    lineNumbers: LineNumberSpec;
    className?: string;
    wordHighlight?: boolean;
    compareLines?: string[];
    editable?: boolean;
    onEdit?: (value: string) => void;
    scrollElementRef?: React.RefObject<HTMLDivElement | HTMLTextAreaElement | null>;
    previewScrollElementRef?: React.RefObject<HTMLDivElement | null>;
    onHorizontalScroll?: (element: HTMLDivElement | HTMLTextAreaElement) => void;
}) {
    const padded = useMemo(() => padLines(lines, lineCount), [lines, lineCount]);
    const paddedCompare = useMemo(() => {
        if (!compareLines) return undefined;
        const alignedCompare = alignCompareLinesForWordDiff(lines, compareLines);
        return padLines(alignedCompare, lineCount);
    }, [compareLines, lineCount, lines]);
    const contentHeight = `${Math.max(lineCount, 1) * EDITOR_LINE_HEIGHT_PX}px`;
    const localPreviewRef = useRef<HTMLDivElement | null>(null);
    const previewRef = previewScrollElementRef ?? localPreviewRef;
    const [isEditing, setIsEditing] = useState(false);

    const renderLineNodes = useCallback(
        (line: string, index: number) => (
            <div key={index} className={`code-line ${line ? "" : "empty-line"}`}>
                <span className="code-line-content">
                    {wordHighlight && paddedCompare ? (
                        <WordDiffLine line={line} compareLine={paddedCompare[index]} />
                    ) : (
                        <HighlightedLine line={line} />
                    )}
                </span>
            </div>
        ),
        [paddedCompare, wordHighlight],
    );

    return (
        <div className={`code-block ${className ?? ""} ${wordHighlight ? "word-highlight" : ""}`}>
            <LineNumbers primary={lineNumbers.primary} secondary={lineNumbers.secondary} />
            {editable ? (
                <div className={`editable-code-shell ${isEditing ? "editing" : ""}`}>
                    <div
                        ref={previewRef as React.Ref<HTMLDivElement>}
                        className="code-scroll code-scroll-preview"
                        style={{ minHeight: contentHeight }}
                    >
                        <div className="code-lines" style={{ minHeight: contentHeight }}>
                            {padded.map(renderLineNodes)}
                        </div>
                    </div>
                    <textarea
                        ref={scrollElementRef as React.RefObject<HTMLTextAreaElement>}
                        className="result-editor-textarea"
                        value={lines.join("\n")}
                        rows={Math.max(lineCount, 1)}
                        wrap="off"
                        style={{ height: contentHeight }}
                        spellCheck={false}
                        onClick={(event) => event.stopPropagation()}
                        onFocus={() => setIsEditing(true)}
                        onBlur={() => setIsEditing(false)}
                        onScroll={(event) => {
                            if (previewRef.current) {
                                previewRef.current.scrollLeft = event.currentTarget.scrollLeft;
                            }
                            onHorizontalScroll?.(event.currentTarget);
                        }}
                        onChange={(event) => onEdit?.(event.target.value)}
                    />
                </div>
            ) : (
                <div
                    ref={scrollElementRef as React.RefObject<HTMLDivElement>}
                    className="code-scroll"
                    style={{ minHeight: contentHeight }}
                    onScroll={(event) => onHorizontalScroll?.(event.currentTarget)}
                >
                    <div className="code-lines" style={{ minHeight: contentHeight }}>
                        {padded.map(renderLineNodes)}
                    </div>
                </div>
            )}
        </div>
    );
}

// --- Hunk helpers ---

export interface SegmentPaneLineNumbers {
    left: LineNumberSpec;
    middle: LineNumberSpec;
    right: LineNumberSpec;
}

function getHunkStatus(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
): {
    label: string;
    tone: "warn" | "ok" | "muted";
} {
    if (segment.changeKind === "ours-only") {
        if (resolution === "ours") {
            return { label: "Applied left-only change", tone: "ok" };
        }
        return resolution === "none"
            ? { label: "Dropped left-only change", tone: "muted" }
            : { label: "Left-only change not applied", tone: "muted" };
    }
    if (segment.changeKind === "theirs-only") {
        if (resolution === "theirs") {
            return { label: "Applied right-only change", tone: "ok" };
        }
        return resolution === "none"
            ? { label: "Dropped right-only change", tone: "muted" }
            : { label: "Right-only change not applied", tone: "muted" };
    }

    if (resolution === undefined) return { label: "Unresolved", tone: "warn" };
    if (resolution === "ours") return { label: "Use left", tone: "ok" };
    if (resolution === "theirs") return { label: "Use right", tone: "ok" };
    if (resolution === "both") return { label: "Use both", tone: "ok" };
    if (resolution === "custom") return { label: "Custom result", tone: "ok" };
    return { label: "Remove block", tone: "muted" };
}

function getHunkKindLabel(segment: ConflictSegment): string {
    if (segment.changeKind === "ours-only") return "Left only";
    if (segment.changeKind === "theirs-only") return "Right only";
    return "Conflict";
}

// --- Section components ---

export function CommonSection({
    segment,
    resultLines,
    lineCount,
    lineNumbers,
    highlightWords,
    onEditResult,
}: {
    segment: CommonSegment;
    resultLines: string[];
    lineCount: number;
    lineNumbers: SegmentPaneLineNumbers;
    highlightWords: boolean;
    onEditResult: (value: string) => void;
}) {
    return (
        <div className="segment segment-common">
            <div className="column column-left">
                <CodeBlock
                    lines={segment.lines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers.left}
                    wordHighlight={highlightWords}
                />
            </div>
            <div className="column column-middle result-column">
                <CodeBlock
                    lines={resultLines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers.middle}
                    wordHighlight={highlightWords}
                    editable
                    onEdit={onEditResult}
                />
            </div>
            <div className="column column-right">
                <CodeBlock
                    lines={segment.lines}
                    lineCount={lineCount}
                    lineNumbers={lineNumbers.right}
                    wordHighlight={highlightWords}
                />
            </div>
        </div>
    );
}

export interface ConflictSectionProps {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    resultLines: string[];
    lineCount: number;
    lineNumbers: SegmentPaneLineNumbers;
    onResolve: (id: number, resolution: HunkResolution) => void;
    onEditResult: (value: string) => void;
    onSelect: (id: number) => void;
    setSectionRef: (el: HTMLDivElement | null) => void;
    isActive: boolean;
    showDetails: boolean;
    highlightWords: boolean;
    conflictOrdinal: number;
    trueConflictOrdinal?: number;
}

export function ConflictSection({
    segment,
    resolution,
    resultLines,
    lineCount,
    lineNumbers,
    onResolve,
    onEditResult,
    onSelect,
    setSectionRef,
    isActive,
    showDetails,
    highlightWords,
    conflictOrdinal,
    trueConflictOrdinal,
}: ConflictSectionProps) {
    const status = getHunkStatus(segment, resolution);
    const leftScrollRef = useRef<HTMLDivElement | HTMLTextAreaElement | null>(null);
    const middleScrollRef = useRef<HTMLDivElement | HTMLTextAreaElement | null>(null);
    const middlePreviewScrollRef = useRef<HTMLDivElement | null>(null);
    const rightScrollRef = useRef<HTMLDivElement | HTMLTextAreaElement | null>(null);
    const isSyncingScrollRef = useRef(false);
    const handleHorizontalScroll = useCallback((source: HTMLDivElement | HTMLTextAreaElement) => {
        if (isSyncingScrollRef.current) return;
        isSyncingScrollRef.current = true;
        const scrollLeft = source.scrollLeft;
        [
            leftScrollRef.current,
            middleScrollRef.current,
            middlePreviewScrollRef.current,
            rightScrollRef.current,
        ].forEach((element) => {
            if (!element || element === source) return;
            element.scrollLeft = scrollLeft;
        });
        requestAnimationFrame(() => {
            isSyncingScrollRef.current = false;
        });
    }, []);

    const isOurs = resolution === "ours";
    const isTheirs = resolution === "theirs";
    const isBoth = resolution === "both";
    const isNone = resolution === "none";
    const isCustom = resolution === "custom";
    const isResolved = segment.changeKind !== "conflict" || resolution !== undefined;
    const kindLabel = getHunkKindLabel(segment);
    const resultCompareLines =
        resolution === "ours"
            ? segment.theirsLines
            : resolution === "theirs"
              ? segment.oursLines
              : segment.baseLines;

    return (
        <div
            ref={setSectionRef}
            className={[
                "segment",
                "segment-conflict",
                `change-${segment.changeKind}`,
                isResolved ? "resolved" : "unresolved",
                isActive ? "active" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            data-conflict-id={segment.id}
            onClick={() => onSelect(segment.id)}
        >
            <div className="hunk-header">
                <div className="hunk-header-left">
                    <span className={`hunk-badge hunk-kind-${segment.changeKind}`}>
                        {trueConflictOrdinal !== undefined
                            ? `#${trueConflictOrdinal}`
                            : `#${conflictOrdinal}`}
                    </span>
                    <span className="hunk-kind-label">{kindLabel}</span>
                    {showDetails ? (
                        <span className="hunk-detail-lines">
                            L:{segment.oursLines.length} R:{segment.theirsLines.length} Result:{" "}
                            {resultLines.length}
                        </span>
                    ) : null}
                </div>
                <div className="hunk-header-center" onClick={(e) => e.stopPropagation()}>
                    <button
                        className={`hunk-choice ${isOurs ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "ours")}
                        title="Use left block"
                    >
                        <IconArrowRight />
                        Left
                    </button>
                    {segment.changeKind === "conflict" ? (
                        <button
                            className={`hunk-choice ${isBoth ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "both")}
                            title="Use both blocks"
                        >
                            <IconSplitBoth />
                            Both
                        </button>
                    ) : null}
                    <button
                        className={`hunk-choice ${isTheirs ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "theirs")}
                        title="Use right block"
                    >
                        <IconArrowLeft />
                        Right
                    </button>
                    <button
                        className={`hunk-choice danger ${isNone ? "active" : ""}`}
                        onClick={() => onResolve(segment.id, "none")}
                        title="Remove this block from result"
                    >
                        <IconClose />
                        Drop
                    </button>
                </div>
                <div className={`hunk-status tone-${status.tone}`}>
                    <span className="toolbar-icon status-icon">
                        {status.tone === "warn" ? (
                            <IconWarning />
                        ) : status.tone === "ok" ? (
                            <IconCheck />
                        ) : (
                            <IconDot />
                        )}
                    </span>
                    {status.label}
                </div>
            </div>

            <div className="hunk-columns">
                <div className={`column column-left conflict-column ${isOurs ? "accepted" : ""}`}>
                    <CodeBlock
                        lines={segment.oursLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.left}
                        className="conflict-ours"
                        wordHighlight={highlightWords}
                        compareLines={segment.theirsLines}
                        scrollElementRef={leftScrollRef}
                        onHorizontalScroll={handleHorizontalScroll}
                    />
                    <div className="conflict-actions-left" onClick={(e) => e.stopPropagation()}>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "theirs")}
                            title="Ignore left block"
                            aria-label="Ignore left block"
                        >
                            <IconClose />
                        </button>
                        <button
                            className={`action-btn accept-btn ${isOurs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Accept left block"
                            aria-label="Accept left block"
                            aria-current={isOurs ? "true" : undefined}
                        >
                            <IconArrowRight />
                        </button>
                    </div>
                </div>

                <div className="column column-middle conflict-column result-column">
                    <CodeBlock
                        lines={resultLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.middle}
                        className={[
                            "conflict-result",
                            isResolved ? "resolved" : "unresolved",
                            isCustom ? "custom" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        wordHighlight={highlightWords}
                        compareLines={resultCompareLines}
                        editable
                        onEdit={onEditResult}
                        scrollElementRef={middleScrollRef}
                        previewScrollElementRef={middlePreviewScrollRef}
                        onHorizontalScroll={handleHorizontalScroll}
                    />
                </div>

                <div
                    className={`column column-right conflict-column ${isTheirs ? "accepted" : ""}`}
                >
                    <div className="conflict-actions-right" onClick={(e) => e.stopPropagation()}>
                        <button
                            className={`action-btn accept-btn ${isTheirs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, "theirs")}
                            title="Accept right block"
                            aria-label="Accept right block"
                            aria-current={isTheirs ? "true" : undefined}
                        >
                            <IconArrowLeft />
                        </button>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Ignore right block"
                            aria-label="Ignore right block"
                        >
                            <IconClose />
                        </button>
                    </div>
                    <CodeBlock
                        lines={segment.theirsLines}
                        lineCount={lineCount}
                        lineNumbers={lineNumbers.right}
                        className="conflict-theirs"
                        wordHighlight={highlightWords}
                        compareLines={segment.oursLines}
                        scrollElementRef={rightScrollRef}
                        onHorizontalScroll={handleHorizontalScroll}
                    />
                </div>
            </div>
        </div>
    );
}

// --- Overview rail ---

export interface OverviewMarker {
    id: number;
    ordinal: number;
    topPct: number;
    heightPct: number;
    changeKind: ConflictSegment["changeKind"];
    resolved: boolean;
}

export function OverviewRail({
    markers,
    activeConflictId,
    onJump,
}: {
    markers: OverviewMarker[];
    activeConflictId: number | null;
    onJump: (id: number) => void;
}) {
    return (
        <div className="overview-rail" aria-label="Conflict overview">
            <div className="overview-track">
                {markers.map((marker) => (
                    <button
                        key={marker.id}
                        className={[
                            "overview-marker",
                            `marker-${marker.changeKind}`,
                            marker.resolved ? "resolved" : "unresolved",
                            activeConflictId === marker.id ? "active" : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        style={{
                            top: `${marker.topPct}%`,
                            height: `${marker.heightPct}%`,
                        }}
                        title={`Jump to hunk #${marker.ordinal}`}
                        aria-label={`Jump to hunk #${marker.ordinal}`}
                        aria-current={activeConflictId === marker.id ? "true" : undefined}
                        onClick={() => onJump(marker.id)}
                    />
                ))}
            </div>
        </div>
    );
}
