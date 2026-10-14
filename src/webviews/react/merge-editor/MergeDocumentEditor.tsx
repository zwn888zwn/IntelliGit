import React, { useEffect, useRef, useState } from "react";
import {
    Compartment,
    EditorState,
    RangeSet,
    StateEffect,
    StateField,
    type Range,
} from "@codemirror/state";
import {
    Decoration,
    EditorView,
    GutterMarker,
    ViewPlugin,
    gutter,
    keymap,
    lineNumbers,
    type DecorationSet,
} from "@codemirror/view";
import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    redo,
    redoDepth,
    undo,
    undoDepth,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import {
    acceptChoice,
    buildMergeDocument,
    mergeDocumentHistory,
    mergeRanges,
    replaceMergeRanges,
    resolveMergeRanges,
    type MergeRange,
} from "./mergeDocumentState";
import { isTrueConflict } from "./mergeState";
import { detectTheme, highlightLine, initShiki, langForPath } from "./shikiHighlighter";
import { buildWordDiffMask, tokenizeWordDiff } from "./wordDiff";
import { getVsCodeApi } from "../shared/vscodeApi";
import type { HunkResolution, MergeEditorData, OutboundMessage } from "./types";
import { t } from "./i18n";
import "./merge-document.css";

type Side = "ours" | "result" | "theirs";
const setSideRanges = StateEffect.define<readonly MergeRange[]>();
const sideRanges = StateField.define<readonly MergeRange[]>({
    create: () => [],
    update(value, transaction) {
        for (const effect of transaction.effects)
            if (effect.is(setSideRanges)) value = effect.value;
        return value;
    },
});

function extent(range: MergeRange, side: Side): [number, number] {
    return side === "ours"
        ? [range.oursFrom, range.oursTo]
        : side === "theirs"
          ? [range.theirsFrom, range.theirsTo]
          : [range.from, range.to];
}

/** Read-only side controls stay attached to the original file, even as the result changes. */
class DecisionMarker extends GutterMarker {
    constructor(
        readonly hunk: MergeRange,
        readonly side: Side,
        readonly decide: (id: number, action: string) => void,
    ) {
        super();
    }
    eq(other: GutterMarker) {
        return (
            other instanceof DecisionMarker && this.hunk === other.hunk && this.side === other.side
        );
    }
    toDOM(): HTMLElement {
        const element = document.createElement("span");
        const button = (label: string, title: string, action: string) => {
            const node = document.createElement("button");
            node.type = "button";
            node.textContent = label;
            node.title = title;
            node.setAttribute("aria-label", title);
            node.onmousedown = (event) => event.preventDefault();
            node.onclick = () => this.decide(this.hunk.id, action);
            element.appendChild(node);
        };
        if (this.side === "result") {
            if (!this.hunk.resolved) button("✓", "Mark this conflict resolved", "resolved");
        } else {
            const side = this.side;
            const choice = this.hunk.choice;
            const accepted =
                !this.hunk.edited &&
                (choice === side || choice === "both" || choice === "both-reversed");
            if (!accepted && !this.hunk.dismissed[side]) {
                const append =
                    !this.hunk.edited && choice === (side === "ours" ? "theirs" : "ours");
                button("✓", append ? "Append this side to the result" : "Accept this side", side);
                button("×", "Discard this side", `discard-${side}`);
            }
        }
        return element;
    }
}

export function MergeDocumentEditor({
    data,
    confirm,
    reload,
}: {
    data: MergeEditorData;
    confirm: (message: string, label: string, action: () => void) => void;
    reload: (mode: "none" | "whitespace") => void;
}): React.ReactElement {
    const hosts = useRef<Array<HTMLDivElement | null>>([]);
    const editors = useRef<EditorView[]>([]);
    const wrapper = useRef<HTMLDivElement>(null);
    const ribbons = useRef<SVGSVGElement>(null);
    const current = useRef<readonly MergeRange[]>([]);
    const active = useRef<number | null>(null);
    const [stats, setStats] = useState({
        unresolved: 0,
        total: 0,
        undo: false,
        redo: false,
        dirty: false,
    });
    const [wrap, setWrap] = useState(false);
    const [words, setWords] = useState(true);
    const wordHighlight = useRef(true);
    const wrapping = useRef(new Compartment());
    const actions = useRef({
        decide: (_id: number, _action: string) => {},
        jump: (_direction: number) => {},
    });

    const apply = () => {
        const view = editors.current[1];
        if (!view || view.state.field(mergeRanges).some((range) => !range.resolved)) return;
        getVsCodeApi<OutboundMessage>().postMessage({
            type: "applyResolution",
            content: view.state.doc.toString().replace(/\n/g, data.eol ?? "\n"),
            mode: "apply",
        });
    };
    const applyRef = useRef(apply);
    applyRef.current = apply;

    useEffect(() => {
        const initial = buildMergeDocument(data);
        let disposed = false;
        let frame = 0;
        let syncing = false;
        initShiki();
        const language = langForPath(data.filePath);
        const paintRibbons = () => {
            if (frame || disposed) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                const svg = ribbons.current,
                    root = wrapper.current;
                if (!svg || !root || editors.current.length !== 3) return;
                svg.replaceChildren();
                const bounds = root.getBoundingClientRect();
                for (const range of current.current) {
                    for (const side of ["ours", "theirs"] as const) {
                        if (
                            range.segment.changeKind ===
                            (side === "ours" ? "theirs-only" : "ours-only")
                        )
                            continue;
                        const input = editors.current[side === "ours" ? 0 : 2],
                            result = editors.current[1];
                        const [from, to] = extent(range, side);
                        const start = input.coordsAtPos(Math.min(from, input.state.doc.length));
                        const end = input.coordsAtPos(
                            Math.min(Math.max(from, to - 1), input.state.doc.length),
                        );
                        const resultStart = result.coordsAtPos(range.from),
                            resultEnd = result.coordsAtPos(Math.max(range.from, range.to - 1));
                        if (!start || !end || !resultStart || !resultEnd) continue;
                        const a = input.dom.getBoundingClientRect(),
                            b = result.dom.getBoundingClientRect();
                        const x1 = (side === "ours" ? a.right : b.right) - bounds.left;
                        const x2 = (side === "ours" ? b.left : a.left) - bounds.left;
                        const y1 = (side === "ours" ? start.top : resultStart.top) - bounds.top;
                        const y2 = (side === "ours" ? resultStart.top : start.top) - bounds.top;
                        const y3 = (side === "ours" ? resultEnd.bottom : end.bottom) - bounds.top;
                        const y4 = (side === "ours" ? end.bottom : resultEnd.bottom) - bounds.top;
                        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                        path.setAttribute(
                            "d",
                            `M${x1},${y1} L${x2},${y2} L${x2},${y3} L${x1},${y4} Z`,
                        );
                        path.setAttribute(
                            "class",
                            range.resolved ? "merge-ribbon-resolved" : "merge-ribbon-pending",
                        );
                        svg.appendChild(path);
                    }
                }
            });
        };
        const rangesFor = (view: EditorView, side: Side) =>
            view.state.field(side === "result" ? mergeRanges : sideRanges);
        const decorations = (view: EditorView, side: Side): DecorationSet => {
            const marks: Range<Decoration>[] = [];
            const ranges = rangesFor(view, side);
            for (const visible of view.visibleRanges) {
                for (
                    let position = view.state.doc.lineAt(visible.from).from;
                    position <= visible.to;
                ) {
                    const line = view.state.doc.lineAt(position);
                    const range = ranges.find((item) => {
                        const [a, b] = extent(item, side);
                        return line.to >= a && line.from < Math.max(a + 1, b);
                    });
                    if (range) {
                        marks.push(
                            Decoration.line({
                                class: range.resolved
                                    ? "merge-line-resolved"
                                    : "merge-line-pending",
                            }).range(line.from),
                        );
                        if (wordHighlight.current) {
                            const [start] = extent(range, side);
                            const lineIndex =
                                line.number -
                                view.state.doc.lineAt(Math.min(start, view.state.doc.length))
                                    .number;
                            const reference = range.segment.baseLines[lineIndex] ?? "";
                            const mask = buildWordDiffMask(line.text, reference);
                            let offset = line.from;
                            tokenizeWordDiff(line.text).forEach((token, index) => {
                                if (mask[index] && token.length)
                                    marks.push(
                                        Decoration.mark({ class: "word-diff-change" }).range(
                                            offset,
                                            offset + token.length,
                                        ),
                                    );
                                offset += token.length;
                            });
                        }
                    }
                    if (language) {
                        let offset = line.from;
                        for (const token of highlightLine(line.text, language, detectTheme()) ??
                            []) {
                            if (token.text.length && token.color)
                                marks.push(
                                    Decoration.mark({
                                        attributes: { style: `color:${token.color}` },
                                    }).range(offset, offset + token.text.length),
                                );
                            offset += token.text.length;
                        }
                    }
                    if (line.to >= view.state.doc.length) break;
                    position = line.to + 1;
                }
            }
            return Decoration.set(marks, true);
        };
        actions.current.decide = (id, action) => {
            const view = editors.current[1];
            const range = view.state.field(mergeRanges).find((item) => item.id === id);
            if (!range) return;
            active.current = id;
            if (action === "resolved") {
                view.dispatch({
                    effects: replaceMergeRanges.of(
                        view.state
                            .field(mergeRanges)
                            .map((item) => (item.id === id ? { ...item, resolved: true } : item)),
                    ),
                });
                return;
            }
            if (action.startsWith("discard-")) {
                const side = action === "discard-ours" ? "ours" : "theirs";
                const dismissed = { ...range.dismissed, [side]: true };
                if (dismissed.ours && dismissed.theirs) {
                    const discard = () =>
                        view.dispatch(
                            resolveMergeRanges(view.state, new Map([[id, "none"]]), data),
                        );
                    if (range.edited)
                        confirm(
                            "Discard the manual edits in this conflict and restore the base version?",
                            "Discard",
                            discard,
                        );
                    else discard();
                } else
                    view.dispatch({
                        effects: replaceMergeRanges.of(
                            view.state
                                .field(mergeRanges)
                                .map((item) =>
                                    item.id === id
                                        ? {
                                              ...item,
                                              dismissed,
                                              resolved:
                                                  item.resolved ||
                                                  item.choice ===
                                                      (side === "ours" ? "theirs" : "ours"),
                                          }
                                        : item,
                                ),
                        ),
                    });
                return;
            }
            const side = action as "ours" | "theirs";
            const accept = () => {
                const latest = view.state.field(mergeRanges).find((item) => item.id === id);
                if (latest)
                    view.dispatch(
                        resolveMergeRanges(
                            view.state,
                            new Map([[id, acceptChoice(latest, side)]]),
                            data,
                        ),
                    );
            };
            if (range.edited)
                confirm(
                    "Replace the manual edits in this conflict with the selected side?",
                    "Replace",
                    accept,
                );
            else accept();
        };
        actions.current.jump = (direction) => {
            const ranges = current.current.filter((range) => isTrueConflict(range.segment));
            if (!ranges.length) return;
            const index = ranges.findIndex((range) => range.id === active.current);
            const range = ranges[(index + direction + ranges.length) % ranges.length];
            active.current = range.id;
            editors.current.forEach((view, pane) => {
                const [from] = extent(range, (["ours", "result", "theirs"] as const)[pane]);
                view.dispatch({
                    selection: { anchor: Math.min(from, view.state.doc.length) },
                    effects: EditorView.scrollIntoView(Math.min(from, view.state.doc.length), {
                        y: "center",
                    }),
                });
            });
        };
        const updateStats = (view: EditorView) => {
            current.current = view.state.field(mergeRanges);
            for (const pane of [editors.current[0], editors.current[2]])
                pane?.dispatch({ effects: setSideRanges.of(current.current) });
            const conflicts = current.current.filter((range) => isTrueConflict(range.segment));
            setStats({
                total: conflicts.length,
                unresolved: conflicts.filter((range) => !range.resolved).length,
                undo: undoDepth(view.state) > 0,
                redo: redoDepth(view.state) > 0,
                dirty:
                    view.state.doc.toString() !== initial.result ||
                    current.current.some(
                        (range) =>
                            range.choice ||
                            range.edited ||
                            range.dismissed.ours ||
                            range.dismissed.theirs,
                    ),
            });
            paintRibbons();
        };
        const views = (["ours", "result", "theirs"] as const).map((side, index) => {
            const editable = side === "result";
            return new EditorView({
                parent: hosts.current[index]!,
                state: EditorState.create({
                    doc: editable
                        ? initial.result
                        : side === "ours"
                          ? initial.ours
                          : initial.theirs,
                    extensions: [
                        editable
                            ? [
                                  mergeRanges.init(() => initial.ranges),
                                  history(),
                                  mergeDocumentHistory,
                              ]
                            : [
                                  sideRanges.init(() => initial.ranges),
                                  EditorState.readOnly.of(true),
                              ],
                        EditorView.contentAttributes.of({
                            "aria-label": `${side} merge editor`,
                            "aria-readonly": String(!editable),
                        }),
                        lineNumbers(),
                        wrapping.current.of([]),
                        gutter({
                            class: "merge-decision-gutter",
                            markers: (view) => {
                                return RangeSet.of(
                                    rangesFor(view, side).flatMap((range) => {
                                        if (
                                            side !== "result" &&
                                            range.segment.changeKind ===
                                                (side === "ours" ? "theirs-only" : "ours-only")
                                        )
                                            return [];
                                        const [position] = extent(range, side);
                                        const line = view.state.doc.lineAt(
                                            Math.min(position, view.state.doc.length),
                                        ).from;
                                        return [
                                            new DecisionMarker(range, side, (id, action) =>
                                                actions.current.decide(id, action),
                                            ).range(line),
                                        ];
                                    }),
                                    true,
                                );
                            },
                        }),
                        keymap.of([
                            {
                                key: "F7",
                                run: () => {
                                    actions.current.jump(1);
                                    return true;
                                },
                            },
                            {
                                key: "Shift-F7",
                                run: () => {
                                    actions.current.jump(-1);
                                    return true;
                                },
                            },
                            {
                                key: "Mod-Enter",
                                run: () => {
                                    applyRef.current();
                                    return true;
                                },
                            },
                            ...searchKeymap,
                            ...(editable ? [...historyKeymap, indentWithTab] : []),
                            ...defaultKeymap,
                        ]),
                        ViewPlugin.fromClass(
                            class {
                                decorations: DecorationSet;
                                constructor(view: EditorView) {
                                    this.decorations = decorations(view, side);
                                }
                                update(update: { view: EditorView }) {
                                    this.decorations = decorations(update.view, side);
                                }
                            },
                            { decorations: (plugin) => plugin.decorations },
                        ),
                        EditorView.updateListener.of((update) => {
                            if (
                                editable &&
                                (update.docChanged ||
                                    update.transactions.some((transaction) =>
                                        transaction.effects.some((effect) =>
                                            effect.is(replaceMergeRanges),
                                        ),
                                    ))
                            )
                                updateStats(update.view);
                            if (editable && update.selectionSet) {
                                const position = update.state.selection.main.head;
                                const range = update.state
                                    .field(mergeRanges)
                                    .find((item) => position >= item.from && position <= item.to);
                                if (range) active.current = range.id;
                            }
                            paintRibbons();
                        }),
                        EditorView.domEventHandlers({
                            scroll: (_event, view) => {
                                paintRibbons();
                                if (syncing) return;
                                syncing = true;
                                const position = view.lineBlockAtHeight(
                                    view.scrollDOM.scrollTop,
                                ).from;
                                const ranges = current.current;
                                const range =
                                    ranges.find((item) => extent(item, side)[1] >= position) ??
                                    ranges.at(-1);
                                for (const [pane, other] of editors.current.entries()) {
                                    if (other === view) continue;
                                    const otherSide = (["ours", "result", "theirs"] as const)[pane];
                                    const sourceAnchor = range ? extent(range, side)[0] : 0;
                                    const targetAnchor = range ? extent(range, otherSide)[0] : 0;
                                    const lineDelta =
                                        view.state.doc.lineAt(position).number -
                                        view.state.doc.lineAt(
                                            Math.min(sourceAnchor, view.state.doc.length),
                                        ).number;
                                    const targetLine = Math.max(
                                        1,
                                        Math.min(
                                            other.state.doc.lines,
                                            other.state.doc.lineAt(
                                                Math.min(targetAnchor, other.state.doc.length),
                                            ).number + lineDelta,
                                        ),
                                    );
                                    other.scrollDOM.scrollTop = other.lineBlockAt(
                                        other.state.doc.line(targetLine).from,
                                    ).top;
                                    other.scrollDOM.scrollLeft = view.scrollDOM.scrollLeft;
                                }
                                requestAnimationFrame(() => {
                                    syncing = false;
                                });
                            },
                            click: (event, view) => {
                                if (!event.metaKey && !event.ctrlKey) return;
                                const position = view.posAtCoords({
                                    x: event.clientX,
                                    y: event.clientY,
                                });
                                if (position == null) return;
                                const line = view.state.doc.lineAt(position);
                                getVsCodeApi<OutboundMessage>().postMessage({
                                    type: "goToDefinition",
                                    pane:
                                        side === "ours"
                                            ? "left"
                                            : side === "result"
                                              ? "middle"
                                              : "right",
                                    lineNumber: line.number,
                                    character: position - line.from,
                                    lineText: line.text,
                                });
                            },
                        }),
                    ],
                }),
            });
        });
        editors.current = views;
        for (const view of views) {
            view.dom.querySelector(".cm-gutters")?.setAttribute("aria-hidden", "false");
            view.dom.querySelector(".cm-lineNumbers")?.setAttribute("aria-hidden", "true");
        }
        updateStats(views[1]);
        const observer = new ResizeObserver(paintRibbons);
        if (wrapper.current) observer.observe(wrapper.current);
        const themeObserver = new MutationObserver(() =>
            views.forEach((view) => view.dispatch({})),
        );
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        return () => {
            disposed = true;
            cancelAnimationFrame(frame);
            observer.disconnect();
            themeObserver.disconnect();
            views.forEach((view) => view.destroy());
            editors.current = [];
        };
    }, [data, confirm]);

    const bulk = (choice: "ours" | "theirs" | "auto") => {
        const applyChoices = () => {
            const view = editors.current[1];
            const choices = new Map<number, HunkResolution>();
            for (const range of view.state.field(mergeRanges)) {
                if (choice !== "auto") choices.set(range.id, choice);
                else if (range.segment.changeKind !== "conflict")
                    choices.set(
                        range.id,
                        range.segment.changeKind === "ours-only" ? "ours" : "theirs",
                    );
            }
            view.dispatch(resolveMergeRanges(view.state, choices, data));
        };
        if (stats.dirty)
            confirm(
                "Replace the affected merge choices and manual edits?",
                "Replace",
                applyChoices,
            );
        else applyChoices();
    };
    const close = () => getVsCodeApi<OutboundMessage>().postMessage({ type: "close" });
    return (
        <div className="merge-editor merge-document">
            <div className="merge-toolbar">
                <div className="toolbar-left">
                    <button
                        className="toolbar-btn"
                        onClick={() => undo(editors.current[1])}
                        disabled={!stats.undo}
                        title={t("merge.toolbar.undo")}
                    >
                        ↶
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={() => redo(editors.current[1])}
                        disabled={!stats.redo}
                        title={t("merge.toolbar.redo")}
                    >
                        ↷
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={() => actions.current.jump(-1)}
                        title="Previous conflict (Shift+F7)"
                    >
                        ↑
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={() => actions.current.jump(1)}
                        title="Next conflict (F7)"
                    >
                        ↓
                    </button>
                    <button className="toolbar-btn" onClick={() => bulk("auto")}>
                        {t("merge.toolbar.applyNonConflicting")}
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={() => {
                            const mode = data.diffOptions?.ignoreWhitespace ? "none" : "whitespace";
                            if (stats.dirty)
                                confirm(
                                    "Changing whitespace mode discards merge choices and edits.",
                                    "Change Ignore Mode",
                                    () => reload(mode),
                                );
                            else reload(mode);
                        }}
                    >
                        {data.diffOptions?.ignoreWhitespace ? "Ignore whitespace" : "Do not ignore"}
                    </button>
                    <label>
                        <input
                            type="checkbox"
                            checked={wrap}
                            onChange={() => {
                                const next = !wrap;
                                setWrap(next);
                                editors.current.forEach((view) =>
                                    view.dispatch({
                                        effects: wrapping.current.reconfigure(
                                            next ? EditorView.lineWrapping : [],
                                        ),
                                    }),
                                );
                            }}
                        />
                        Wrap
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={words}
                            onChange={() => {
                                wordHighlight.current = !words;
                                setWords(!words);
                                editors.current.forEach((view) => view.dispatch({}));
                            }}
                        />
                        Words
                    </label>
                </div>
                <div className="toolbar-right">
                    <button className="toolbar-btn" onClick={() => bulk("ours")}>
                        {t("merge.toolbar.acceptAllYours.label")}
                    </button>
                    <button className="toolbar-btn" onClick={() => bulk("theirs")}>
                        {t("merge.toolbar.acceptAllTheirs.label")}
                    </button>
                </div>
            </div>
            <div className="merge-header">
                <span className="file-path">{data.filePath}</span>
                <span>
                    {stats.unresolved} unresolved / {stats.total} conflicts
                </span>
            </div>
            <div className="merge-document-labels">
                <span>{data.oursLabel}</span>
                <span>Result · editable</span>
                <span>{data.theirsLabel}</span>
            </div>
            <div className="merge-document-panes" ref={wrapper}>
                {[0, 1, 2].map((index) => (
                    <div
                        className="merge-document-pane"
                        key={index}
                        ref={(node) => {
                            hosts.current[index] = node;
                        }}
                    />
                ))}
                <svg ref={ribbons} className="merge-document-ribbons" aria-hidden="true" />
            </div>
            <div className="merge-footer">
                <div className="footer-left">
                    <button
                        className="footer-btn secondary ghost"
                        onClick={() =>
                            confirm(
                                "Use the entire ours version and discard merge edits?",
                                "Use Ours",
                                () =>
                                    getVsCodeApi<OutboundMessage>().postMessage({
                                        type: "acceptYours",
                                    }),
                            )
                        }
                    >
                        {t("merge.footer.useFileOurs")}
                    </button>
                    <button
                        className="footer-btn secondary ghost"
                        onClick={() =>
                            confirm(
                                "Use the entire theirs version and discard merge edits?",
                                "Use Theirs",
                                () =>
                                    getVsCodeApi<OutboundMessage>().postMessage({
                                        type: "acceptTheirs",
                                    }),
                            )
                        }
                    >
                        {t("merge.footer.useFileTheirs")}
                    </button>
                    <span className="footer-hint">
                        F7 navigate · Ctrl/Cmd+F find · Ctrl/Cmd+Enter apply
                    </span>
                </div>
                <div className="footer-right">
                    <button
                        className="footer-btn secondary"
                        onClick={() =>
                            stats.dirty
                                ? confirm(
                                      "Discard all merge choices and edits?",
                                      "Discard and Close",
                                      close,
                                  )
                                : close()
                        }
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        className="footer-btn primary"
                        disabled={stats.unresolved > 0}
                        onClick={apply}
                    >
                        {t("merge.footer.apply", {
                            resolved: stats.total - stats.unresolved,
                            total: stats.total,
                        })}
                    </button>
                </div>
            </div>
        </div>
    );
}
