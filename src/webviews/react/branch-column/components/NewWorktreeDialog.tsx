import React, { useEffect, useMemo, useState } from "react";
import type { Branch, GitWorktree, RepositoryContextInfo } from "../../../../types";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type { CreateWorktreePayload } from "../../commitGraphTypes";

interface WorktreeCreateError {
    success: false;
    message: string;
}

interface WorktreeLocationSelection {
    seq: number;
    location: string;
}

interface Props {
    repository: RepositoryContextInfo;
    branches: Branch[];
    initialBranch: Branch;
    defaultLocation: string;
    defaultProjectName: string;
    worktrees: GitWorktree[];
    locationSelection?: WorktreeLocationSelection | null;
    createError?: WorktreeCreateError | null;
    onChooseLocation: (currentLocation: string) => void;
    onCreate: (payload: CreateWorktreePayload) => void;
    onClose: () => void;
}

const CONTROL_HEIGHT = 32;
const LABEL_WIDTH = 104;

export function NewWorktreeDialog({
    repository,
    branches,
    initialBranch,
    defaultLocation,
    defaultProjectName,
    worktrees,
    locationSelection,
    createError,
    onChooseLocation,
    onCreate,
    onClose,
}: Props): React.ReactElement {
    const [selectedBranchName, setSelectedBranchName] = useState(initialBranch.name);
    const [createBranch, setCreateBranch] = useState(false);
    const [newBranchName, setNewBranchName] = useState("");
    const [projectName, setProjectName] = useState(defaultProjectName);
    const [location, setLocation] = useState(defaultLocation);
    const [projectNameDirty, setProjectNameDirty] = useState(false);
    const [isCreating, setIsCreating] = useState(false);

    useEffect(() => {
        setSelectedBranchName(initialBranch.name);
        setCreateBranch(false);
        setNewBranchName("");
        setProjectName(defaultProjectName);
        setLocation(defaultLocation);
        setProjectNameDirty(false);
        setIsCreating(false);
    }, [initialBranch.name, defaultLocation, defaultProjectName]);

    useEffect(() => {
        if (!locationSelection) return;
        setLocation(locationSelection.location);
    }, [locationSelection]);

    useEffect(() => {
        if (createError) setIsCreating(false);
    }, [createError]);

    const selectableBranches = useMemo(() => {
        const byName = new Map<string, Branch>();
        byName.set(initialBranch.name, initialBranch);
        for (const branch of branches) byName.set(branch.name, branch);
        return Array.from(byName.values());
    }, [branches, initialBranch]);

    const selectedBranch = useMemo(
        () => selectableBranches.find((branch) => branch.name === selectedBranchName) ?? initialBranch,
        [initialBranch, selectableBranches, selectedBranchName],
    );

    useEffect(() => {
        if (projectNameDirty) return;
        const nameSource = createBranch && newBranchName.trim() ? newBranchName : selectedBranch.name;
        setProjectName(defaultProjectNameFor(repository.name, nameSource));
    }, [createBranch, newBranchName, projectNameDirty, repository.name, selectedBranch.name]);

    const localBranchCheckedOut =
        !selectedBranch.isRemote &&
        worktrees.some((worktree) => worktree.branch === selectedBranch.name);
    const branchNameError =
        createBranch && !isValidBranchName(newBranchName.trim())
            ? "Enter a valid new branch name."
            : null;
    const projectNameError = validateProjectName(projectName);
    const locationError = location.trim() ? null : "Location is required.";
    const mustCreateBranchError =
        localBranchCheckedOut && !createBranch
            ? "This local branch is already checked out. Enable New branch to create a worktree."
            : null;
    const validationMessage =
        branchNameError || projectNameError || locationError || mustCreateBranchError || createError?.message;
    const canCreate = !validationMessage && !isCreating;
    const targetPath = joinPath(location.trim(), projectName.trim());

    const submit = (event?: React.FormEvent): void => {
        event?.preventDefault();
        if (!canCreate) return;
        setIsCreating(true);
        onCreate({
            repoRoot: repository.root,
            branchName: selectedBranch.name,
            createBranch,
            newBranchName: createBranch ? newBranchName.trim() : undefined,
            projectName: projectName.trim(),
            location: location.trim(),
        });
    };

    return (
        <div style={BACKDROP_STYLE} role="presentation" onMouseDown={onClose}>
            <form
                aria-label="New Worktree"
                onSubmit={submit}
                onMouseDown={(event) => event.stopPropagation()}
                style={DIALOG_STYLE}
            >
                <div style={TITLE_STYLE}>New Worktree</div>
                <Field label="From branch:">
                    <select
                        value={selectedBranch.name}
                        onChange={(event) => setSelectedBranchName(event.target.value)}
                        style={SELECT_STYLE}
                        aria-label="From branch"
                    >
                        {selectableBranches.map((branch) => (
                            <option key={`${branch.isRemote ? "remote" : "local"}-${branch.name}`} value={branch.name}>
                                {branch.name}    {repository.name}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="New branch:">
                    <div style={CHECKBOX_INPUT_ROW_STYLE}>
                        <input
                            aria-label="New branch"
                            type="checkbox"
                            checked={createBranch}
                            onChange={(event) => setCreateBranch(event.target.checked)}
                            style={CHECKBOX_STYLE}
                        />
                        <input
                            value={newBranchName}
                            onChange={(event) => setNewBranchName(event.target.value)}
                            disabled={!createBranch}
                            placeholder="branch-name"
                            style={{
                                ...INPUT_STYLE,
                                opacity: createBranch ? 1 : 0.74,
                            }}
                            aria-label="New branch name"
                        />
                    </div>
                </Field>
                <Field label="Project name:">
                    <input
                        value={projectName}
                        onChange={(event) => {
                            setProjectNameDirty(true);
                            setProjectName(event.target.value);
                        }}
                        style={INPUT_STYLE}
                        aria-label="Project name"
                    />
                </Field>
                <Field label="Location:">
                    <div style={LOCATION_ROW_STYLE}>
                        <input
                            value={location}
                            onChange={(event) => setLocation(event.target.value)}
                            style={INPUT_STYLE}
                            aria-label="Location"
                        />
                        <button
                            type="button"
                            aria-label="Choose location"
                            onClick={() => onChooseLocation(location)}
                            style={ICON_BUTTON_STYLE}
                        >
                            <FolderIcon />
                        </button>
                    </div>
                    <div style={TARGET_HINT_STYLE}>
                        The worktree will be created in:
                        <br />
                        {targetPath || "-"}
                    </div>
                </Field>
                {validationMessage && <div style={ERROR_STYLE}>{validationMessage}</div>}
                <div style={BUTTON_ROW_STYLE}>
                    <button type="button" onClick={onClose} style={SECONDARY_BUTTON_STYLE}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={!canCreate}
                        style={{
                            ...PRIMARY_BUTTON_STYLE,
                            opacity: canCreate ? 1 : 0.48,
                            cursor: canCreate ? "pointer" : "default",
                        }}
                    >
                        {isCreating ? "Creating..." : "Create Worktree"}
                    </button>
                </div>
            </form>
        </div>
    );
}

function Field({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>{label}</span>
            <span style={FIELD_BODY_STYLE}>{children}</span>
        </label>
    );
}

function FolderIcon(): React.ReactElement {
    return (
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
                fill="currentColor"
                d="M1.75 3A1.75 1.75 0 0 1 3.5 1.25h3.1c.46 0 .9.18 1.24.5l1.05 1H12.5A1.75 1.75 0 0 1 14.25 4.5v7A1.75 1.75 0 0 1 12.5 13.25h-9A1.75 1.75 0 0 1 1.75 11.5v-8.5Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .14.11.25.25.25h9a.25.25 0 0 0 .25-.25v-7a.25.25 0 0 0-.25-.25H8.29L6.81 2.84a.3.3 0 0 0-.21-.09H3.5Z"
            />
        </svg>
    );
}

function defaultProjectNameFor(repoName: string, sourceName: string): string {
    return `${repoName}-${sanitizeNamePart(sourceName)}`;
}

function sanitizeNamePart(value: string): string {
    const sanitized = replaceControlCharsWithDash(value.trim())
        .replace(/[\\/]+/g, "-")
        .replace(/[^A-Za-z0-9._@-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "");
    return sanitized || "worktree";
}

function validateProjectName(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return "Project name is required.";
    if (trimmed === "." || trimmed === "..") return "Project name must be a directory name.";
    if (trimmed.includes("/") || trimmed.includes("\\")) {
        return "Project name must not contain path separators.";
    }
    if (containsControlChars(trimmed)) {
        return "Project name must not contain control characters.";
    }
    return null;
}

function isValidBranchName(value: string): boolean {
    if (!value || value.length > 255) return false;
    if (value.startsWith("-") || value.startsWith(".")) return false;
    if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) return false;
    if (value.includes("..") || value.includes("//")) return false;
    if (/[ ~^:?*[\]\\]/.test(value)) return false;
    if (containsControlChars(value)) return false;
    if (value.includes("@{")) return false;
    return value
        .split("/")
        .every((segment) => segment && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

function replaceControlCharsWithDash(value: string): string {
    let result = "";
    let lastWasDash = false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            if (!lastWasDash) result += "-";
            lastWasDash = true;
            continue;
        }
        result += value[i];
        lastWasDash = value[i] === "-";
    }
    return result;
}

function containsControlChars(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

function joinPath(location: string, projectName: string): string {
    if (!location || !projectName) return "";
    const separator = location.includes("\\") && !location.includes("/") ? "\\" : "/";
    return `${location.replace(/[\\/]+$/g, "")}${separator}${projectName}`;
}

const BACKDROP_STYLE: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.28)",
    fontFamily: SYSTEM_FONT_STACK,
};

const DIALOG_STYLE: React.CSSProperties = {
    width: "min(560px, calc(100vw - 32px))",
    background: "var(--vscode-editorWidget-background, #2b2d30)",
    color: "var(--vscode-foreground, #d7d7d7)",
    border: "1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.14))",
    borderRadius: 10,
    boxShadow: "0 24px 72px rgba(0,0,0,0.54), 0 2px 8px rgba(0,0,0,0.36)",
    padding: "16px 20px 18px",
};

const TITLE_STYLE: React.CSSProperties = {
    fontSize: 18,
    fontWeight: 650,
    color: "var(--vscode-foreground, #d7d7d7)",
    marginBottom: 16,
};

const FIELD_STYLE: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)`,
    gap: 10,
    alignItems: "start",
    marginBottom: 12,
};

const LABEL_STYLE: React.CSSProperties = {
    minHeight: CONTROL_HEIGHT,
    display: "flex",
    alignItems: "center",
    fontSize: 13,
    fontWeight: 600,
};

const FIELD_BODY_STYLE: React.CSSProperties = {
    display: "block",
    minWidth: 0,
};

const INPUT_STYLE: React.CSSProperties = {
    width: "100%",
    height: CONTROL_HEIGHT,
    borderRadius: 6,
    border: "1px solid var(--vscode-input-border, rgba(255,255,255,0.18))",
    background: "var(--vscode-input-background, #2f3136)",
    color: "var(--vscode-input-foreground, #d7d7d7)",
    padding: "0 10px",
    fontSize: 13,
    fontFamily: SYSTEM_FONT_STACK,
    outline: "none",
};

const SELECT_STYLE: React.CSSProperties = {
    ...INPUT_STYLE,
    appearance: "auto",
};

const CHECKBOX_INPUT_ROW_STYLE: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "20px minmax(0, 1fr)",
    gap: 10,
    alignItems: "center",
};

const CHECKBOX_STYLE: React.CSSProperties = {
    width: 16,
    height: 16,
    margin: 0,
    accentColor: "var(--vscode-button-background, #3478f6)",
};

const LOCATION_ROW_STYLE: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 36px",
    gap: 8,
};

const ICON_BUTTON_STYLE: React.CSSProperties = {
    width: 36,
    height: CONTROL_HEIGHT,
    borderRadius: 6,
    border: "1px solid var(--vscode-input-border, rgba(255,255,255,0.18))",
    background: "var(--vscode-input-background, #2f3136)",
    color: "var(--vscode-icon-foreground, #c7c7c7)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
};

const TARGET_HINT_STYLE: React.CSSProperties = {
    marginTop: 8,
    color: "var(--vscode-descriptionForeground, #8d929b)",
    fontSize: 12,
    lineHeight: "17px",
    overflowWrap: "anywhere",
};

const ERROR_STYLE: React.CSSProperties = {
    margin: "-2px 0 14px",
    paddingLeft: LABEL_WIDTH + 12,
    color: "var(--vscode-errorForeground, #f48771)",
    fontSize: 12,
};

const BUTTON_ROW_STYLE: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 18,
};

const BUTTON_BASE_STYLE: React.CSSProperties = {
    minWidth: 118,
    height: 34,
    borderRadius: 6,
    padding: "0 18px",
    fontSize: 13,
    fontWeight: 600,
    fontFamily: SYSTEM_FONT_STACK,
};

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
    ...BUTTON_BASE_STYLE,
    border: "1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.18))",
    color: "var(--vscode-button-secondaryForeground, #d7d7d7)",
    background: "var(--vscode-button-secondaryBackground, transparent)",
    cursor: "pointer",
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
    ...BUTTON_BASE_STYLE,
    border: "1px solid var(--vscode-button-background, #3478f6)",
    color: "var(--vscode-button-foreground, #fff)",
    background: "var(--vscode-button-background, #3478f6)",
};
