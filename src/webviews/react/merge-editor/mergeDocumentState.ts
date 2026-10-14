import {
    StateEffect,
    StateField,
    type ChangeDesc,
    type EditorState,
    type TransactionSpec,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { getResultLines, isTrueConflict } from "./mergeState";
import type { ConflictSegment, HunkResolution, MergeEditorData } from "./types";

export interface MergeRange {
    id: number;
    from: number;
    to: number;
    oursFrom: number;
    oursTo: number;
    theirsFrom: number;
    theirsTo: number;
    segment: ConflictSegment;
    choice?: HunkResolution;
    dismissed: { ours?: boolean; theirs?: boolean };
    edited: boolean;
    resolved: boolean;
}

function linesText(lines: string[]): string {
    return lines.length ? lines.join("\n") + "\n" : "";
}

/** Original side coordinates stay fixed; result ranges follow every editor transaction. */
export function buildMergeDocument(data: MergeEditorData) {
    let result = "",
        ours = "",
        theirs = "";
    const ranges: MergeRange[] = [];
    for (const segment of data.segments) {
        if (segment.type === "common") {
            const text = linesText(segment.lines);
            result += text;
            ours += text;
            theirs += text;
        } else {
            const text = linesText(getResultLines(segment, undefined));
            const left = linesText(segment.oursLines),
                right = linesText(segment.theirsLines);
            ranges.push({
                id: segment.id,
                segment,
                from: result.length,
                to: result.length + text.length,
                oursFrom: ours.length,
                oursTo: ours.length + left.length,
                theirsFrom: theirs.length,
                theirsTo: theirs.length + right.length,
                edited: false,
                resolved: !isTrueConflict(segment),
                dismissed: {},
            });
            result += text;
            ours += left;
            theirs += right;
        }
    }
    if (!data.hasTrailingNewline) {
        result = result.replace(/\n$/, "");
        ours = ours.replace(/\n$/, "");
        theirs = theirs.replace(/\n$/, "");
    }
    for (const range of ranges) {
        range.from = Math.min(range.from, result.length);
        range.to = Math.min(range.to, result.length);
        range.oursFrom = Math.min(range.oursFrom, ours.length);
        range.oursTo = Math.min(range.oursTo, ours.length);
        range.theirsFrom = Math.min(range.theirsFrom, theirs.length);
        range.theirsTo = Math.min(range.theirsTo, theirs.length);
    }
    return { result, ours, theirs, ranges };
}

function mapRanges(
    ranges: readonly MergeRange[],
    changes: ChangeDesc,
    markEdited = false,
): MergeRange[] {
    let previous = 0;
    return ranges.map((range) => {
        const from = Math.max(previous, changes.mapPos(range.from, -1));
        const to = Math.max(from, changes.mapPos(range.to, 1));
        previous = to;
        let edited = false;
        changes.iterChangedRanges((start, end) => {
            if (markEdited && start <= range.to && end >= range.from) edited = true;
        });
        return {
            ...range,
            from,
            to,
            edited: range.edited || edited,
            resolved: edited && isTrueConflict(range.segment) ? false : range.resolved,
        };
    });
}

export const replaceMergeRanges = StateEffect.define<readonly MergeRange[]>({ map: mapRanges });
export const mergeRanges = StateField.define<readonly MergeRange[]>({
    create: () => [],
    update(ranges, transaction) {
        let next = transaction.docChanged ? mapRanges(ranges, transaction.changes, true) : ranges;
        for (const effect of transaction.effects)
            if (effect.is(replaceMergeRanges)) next = effect.value;
        return next;
    },
});

export const mergeDocumentHistory = invertedEffects.of((transaction) =>
    transaction.docChanged || transaction.effects.some((effect) => effect.is(replaceMergeRanges))
        ? [replaceMergeRanges.of(transaction.startState.field(mergeRanges))]
        : [],
);

/** Each accept/append is a single undo step, with ranges computed in the new document. */
export function resolveMergeRanges(
    state: EditorState,
    choices: ReadonlyMap<number, HunkResolution>,
    data: MergeEditorData,
): TransactionSpec {
    const changes: { from: number; to: number; insert: string }[] = [];
    let delta = 0;
    const ranges = state.field(mergeRanges).map((range) => {
        const from = range.from + delta;
        const choice = choices.get(range.id);
        if (choice === undefined) return { ...range, from, to: range.to + delta };
        let text = linesText(getResultLines(range.segment, choice));
        if (range.to === state.doc.length && !data.hasTrailingNewline)
            text = text.replace(/\n$/, "");
        if (
            text &&
            range.segment.baseLines.length === 0 &&
            range.from > 0 &&
            state.doc.sliceString(range.from - 1, range.from) !== "\n"
        )
            text = "\n" + text;
        changes.push({ from: range.from, to: range.to, insert: text });
        delta += text.length - (range.to - range.from);
        return {
            ...range,
            from,
            to: from + text.length,
            choice,
            edited: false,
            resolved: true,
            dismissed: {},
        };
    });
    return {
        changes,
        effects: replaceMergeRanges.of(ranges),
        annotations: isolateHistory.of("full"),
        userEvent: "input.merge",
    };
}

/** A second side appends only while the result still represents an unchanged side choice. */
export function acceptChoice(range: MergeRange, side: "ours" | "theirs"): HunkResolution {
    if (!range.edited && side === "ours" && range.choice === "theirs") return "both-reversed";
    if (!range.edited && side === "theirs" && range.choice === "ours") return "both";
    return side;
}
