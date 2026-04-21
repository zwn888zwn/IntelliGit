// Manages the set of checked file paths with 3-level checkbox logic
// (file, folder, section). Persists state via vscode.getState/setState.

import { useState, useCallback, useEffect } from "react";
import { getVsCodeApi } from "./useVsCodeApi";
import type { WorkingFile } from "../../../../types";

interface CheckedFilesAPI {
    checkedPaths: Set<string>;
    toggleFile: (file: WorkingFile) => void;
    toggleFolder: (files: WorkingFile[]) => void;
    toggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
}

export function getCheckedFileKey(file: Pick<WorkingFile, "repoRoot" | "path">): string {
    return `${file.repoRoot}\u0000${file.path}`;
}

export function useCheckedFiles(allFiles: WorkingFile[]): CheckedFilesAPI {
    const [checkedPaths, setCheckedPaths] = useState<Set<string>>(() => {
        const vscode = getVsCodeApi();
        const saved = vscode.getState();
        const arr = (saved as { checked?: string[] } | undefined)?.checked;
        return new Set(arr ?? []);
    });

    // Prune stale paths when file list changes
    useEffect(() => {
        const validPaths = new Set(allFiles.map((f) => getCheckedFileKey(f)));
        setCheckedPaths((prev) => {
            const next = new Set<string>();
            for (const p of prev) {
                if (validPaths.has(p)) next.add(p);
            }
            if (next.size === prev.size) return prev;
            return next;
        });
    }, [allFiles]);

    // Persist to vscode state on every change (merge to preserve other keys)
    useEffect(() => {
        const vscode = getVsCodeApi();
        const prev = vscode.getState() ?? {};
        vscode.setState({ ...prev, checked: Array.from(checkedPaths) });
    }, [checkedPaths]);

    const toggleFile = useCallback((file: WorkingFile) => {
        const path = getCheckedFileKey(file);
        setCheckedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const toggleMany = useCallback((paths: string[]) => {
        if (paths.length === 0) return;
        setCheckedPaths((prev) => {
            const next = new Set(prev);
            const allChecked = paths.every((path) => next.has(path));
            for (const path of paths) {
                if (allChecked) next.delete(path);
                else next.add(path);
            }
            return next;
        });
    }, []);

    const toggleGroup = useCallback(
        (files: WorkingFile[]) => {
            toggleMany(files.map((file) => getCheckedFileKey(file)));
        },
        [toggleMany],
    );

    // Intentional aliases for call-site clarity. If folder/section behavior diverges,
    // split these into separate callbacks to keep memo/dependency behavior explicit.
    const toggleFolder = toggleGroup;
    const toggleSection = toggleGroup;

    const isAllChecked = useCallback(
        (files: WorkingFile[]) =>
            files.length > 0 && files.every((f) => checkedPaths.has(getCheckedFileKey(f))),
        [checkedPaths],
    );

    const isSomeChecked = useCallback(
        (files: WorkingFile[]) =>
            files.some((f) => checkedPaths.has(getCheckedFileKey(f))) &&
            !files.every((f) => checkedPaths.has(getCheckedFileKey(f))),
        [checkedPaths],
    );

    return {
        checkedPaths,
        toggleFile,
        toggleFolder,
        toggleSection,
        isAllChecked,
        isSomeChecked,
    };
}
