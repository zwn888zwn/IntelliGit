import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Branch, BranchTrackingPreview } from "../../../../types";
import type { CommitGraphInbound, CommitGraphOutbound } from "../../commitGraphTypes";
import { TooltipSurface } from "../../shared/TooltipSurface";
import { getVsCodeApi } from "../../shared/vscodeApi";

let nextRequest = 0;
const singleLine: React.CSSProperties = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" };

function CommitSubjects({ label, count, subjects }: { label: string; count: number; subjects: string[] }) {
    if (!count) return null;
    return <div style={{ minWidth: 0 }}>
        <strong>{label} · {count}</strong>
        {subjects.map((subject, index) => <div key={index} style={singleLine}>{subject}</div>)}
        {count > subjects.length && <div style={{ color: "var(--vscode-descriptionForeground)" }}>
            +{count - subjects.length} more
        </div>}
    </div>;
}

interface Props {
    branch: Branch;
    repoRoot?: string;
    anchor: DOMRect;
    fallback: string;
    dismiss: () => void;
}

export function BranchTrackingTooltip({ branch, repoRoot, anchor, fallback, dismiss }: Props) {
    const [preview, setPreview] = useState<BranchTrackingPreview>();
    const bubble = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!repoRoot || branch.isRemote || !branch.upstream || !(branch.ahead || branch.behind)) return;
        const requestId = ++nextRequest;
        const receive = ({ data }: MessageEvent<CommitGraphInbound>) => {
            if (data?.type === "trackingPreview" && data.requestId === requestId) setPreview(data.preview);
        };
        window.addEventListener("message", receive);
        getVsCodeApi<CommitGraphOutbound, unknown>().postMessage({
            type: "getTrackingPreview", repoRoot, branchName: branch.name, requestId,
        });
        return () => window.removeEventListener("message", receive);
    }, [repoRoot, branch.name, branch.isRemote, branch.upstream, branch.ahead, branch.behind]);

    useLayoutEffect(() => {
        const box = bubble.current;
        if (!box) return;
        const { width, height } = box.getBoundingClientRect();
        const below = anchor.bottom + 5;
        box.style.left = Math.max(6, Math.min(anchor.left, window.innerWidth - width - 6)) + "px";
        box.style.top = (below + height + 6 <= window.innerHeight ? below : Math.max(6, anchor.top - height - 5)) + "px";
    }, [anchor, preview]);

    useEffect(() => {
        window.addEventListener("scroll", dismiss, true);
        window.addEventListener("resize", dismiss);
        window.addEventListener("blur", dismiss);
        return () => {
            window.removeEventListener("scroll", dismiss, true);
            window.removeEventListener("resize", dismiss);
            window.removeEventListener("blur", dismiss);
        };
    }, [dismiss]);

    // Short bottom panels have more room across than down.
    const sideBySide = window.innerHeight < 280 && window.innerWidth >= 420 && branch.ahead > 0 && branch.behind > 0;
    return createPortal(<TooltipSurface ref={bubble} style={{
        position: "fixed", zIndex: 10000, pointerEvents: "none", boxSizing: "border-box",
        width: "max-content", maxWidth: `min(${sideBySide ? 560 : 350}px, calc(100vw - 12px))`,
    }}>
        {preview ? <>
            <div style={{ display: "grid", gridTemplateColumns: sideBySide ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: "4px 12px" }}>
                <CommitSubjects label="Incoming" count={branch.behind} subjects={preview.incoming} />
                <CommitSubjects label="Outgoing" count={branch.ahead} subjects={preview.outgoing} />
            </div>
            {branch.isCurrent && branch.behind > 0 && <div style={{ marginTop: 3, color: "var(--vscode-descriptionForeground)" }}>
                {branch.ahead > 0 ? "Update would rebase local commits onto the upstream." : "Update would fast-forward this branch."}
            </div>}
            <div style={{ ...singleLine, color: "var(--vscode-descriptionForeground)" }}>{branch.upstream} · Last fetched state</div>
        </> : fallback}
    </TooltipSurface>, document.body);
}
