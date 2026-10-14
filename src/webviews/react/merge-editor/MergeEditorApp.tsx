// Hosts the full-document merge editor and its extension-host confirmation protocol.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MergeDocumentEditor } from "./MergeDocumentEditor";
import { getVsCodeApi } from "../shared/vscodeApi";
import type { InboundMessage, MergeEditorData, OutboundMessage } from "./types";
import "./merge-editor.css";

function App() {
    const [data, setData] = useState<MergeEditorData | null>(null);
    const [error, setError] = useState("");
    const requestId = useRef(0);
    const confirmations = useRef(new Map<number, () => void>());
    const confirm = useCallback((message: string, confirmLabel: string, action: () => void) => {
        const id = ++requestId.current;
        confirmations.current.set(id, action);
        getVsCodeApi<OutboundMessage>().postMessage({
            type: "confirm",
            requestId: id,
            message,
            confirmLabel,
        });
    }, []);
    const reload = useCallback((mode: "none" | "whitespace") => {
        getVsCodeApi<OutboundMessage>().postMessage({ type: "setIgnoreMode", mode });
    }, []);

    useEffect(() => {
        const receive = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setConflictData") {
                confirmations.current.clear();
                setData(event.data.data);
                setError("");
            } else if (event.data.type === "loadError") {
                setError(event.data.message);
            } else if (event.data.type === "confirmResult") {
                const action = confirmations.current.get(event.data.requestId);
                confirmations.current.delete(event.data.requestId);
                if (event.data.confirmed) action?.();
            }
        };
        window.addEventListener("message", receive);
        getVsCodeApi<OutboundMessage>().postMessage({ type: "ready" });
        return () => window.removeEventListener("message", receive);
    }, []);

    if (error)
        return (
            <div className="merge-editor loading">
                <div className="error-message">{error}</div>
                <button
                    onClick={() => getVsCodeApi<OutboundMessage>().postMessage({ type: "ready" })}
                >
                    Retry
                </button>
            </div>
        );
    if (!data) return <div className="merge-editor loading">Loading merge…</div>;
    return <MergeDocumentEditor data={data} confirm={confirm} reload={reload} />;
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
