import { existsSync } from "fs";
import { join } from "path";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import type { GitExecutor } from "./executor";

export interface SquashPlan {
    branch: string;
    head: string;
    parent: string;
    tree: string;
    hashes: string[];
    message: string;
    commits: { hash: string; subject: string }[];
}

type Reader = Pick<GitExecutor, "run">;

async function checkedBranch(executor: Reader): Promise<string> {
    const gitDir = (await executor.run(["rev-parse", "--absolute-git-dir"])).trim();
    const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];
    if (markers.some(marker => existsSync(join(gitDir, marker)))) {
        throw new Error("Finish the current Git operation before rewriting commits.");
    }
    return (await executor.run(["symbolic-ref", "--quiet", "HEAD"])).trim();
}

async function requireUnpublished(executor: Reader, oldest: string): Promise<void> {
    const refs = await executor.run(["for-each-ref", "--count=1", "--format=%(refname)", "--contains", oldest, "refs/remotes/"]);
    if (refs.trim()) throw new Error("This history is already present on a remote-tracking branch.");
}

// commit-tree bypasses commit-msg. Validate the user's new message just as
// a normal commit would, without sharing Git's mutable COMMIT_EDITMSG file.
async function checkedMessage(executor: Reader, text: string): Promise<string> {
    if (!text.trim() || text.includes("\0")) throw new Error("Enter a valid commit message.");
    const hooks = (await executor.run(["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).trim();
    if (!existsSync(join(hooks, "commit-msg"))) return text;
    const dir = await mkdtemp(join(tmpdir(), "intelligit-message-"));
    try {
        const file = join(dir, "COMMIT_EDITMSG");
        await writeFile(file, text.endsWith("\n") ? text : text + "\n");
        await executor.run(["hook", "run", "--ignore-missing", "commit-msg", "--", file]);
        const checked = await readFile(file, "utf8");
        if (!checked.trim() || checked.includes("\0")) throw new Error("The commit-msg hook returned an invalid message.");
        return checked;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

async function usesCommitSigning(executor: Reader): Promise<boolean> {
    return (await executor.run(["config", "--default=false", "--bool", "--get", "commit.gpgsign"])).trim() === "true";
}

/** Only a consecutive, unpublished suffix of the checked-out branch may be squashed. */
export async function prepareSquash(
    executor: Pick<GitExecutor, "run">,
    selection: string[] | string,
): Promise<SquashPlan> {
    const branch = await checkedBranch(executor);
    let hashes: string[];
    if (typeof selection === "string") {
        if (!/^[a-f0-9]{7,40}$/i.test(selection)) throw new Error("Invalid commit.");
        const target = (await executor.run(["rev-parse", "--verify", `${selection}^{commit}`])).trim();
        const tips = (await executor.run(["rev-list", "--first-parent", "--max-count=500", "HEAD"])).trim().split("\n");
        hashes = tips.slice(0, tips.indexOf(target) + 1);
    } else {
        hashes = selection;
    }
    if (!Array.isArray(hashes) || hashes.length < 2 || hashes.length > 500 ||
        hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{7,40}$/i.test(hash))) {
        throw new Error("Select two or more consecutive local commits ending at HEAD (up to 500).");
    }
    const selected = await Promise.all(hashes.map(async hash => {
        if (hash.length === 40) return hash.toLowerCase();
        return (await executor.run(["rev-parse", "--verify", `${hash}^{commit}`])).trim();
    }));
    const selectedSet = new Set(selected);
    if (selectedSet.size !== selected.length)
        throw new Error("Select distinct commits to squash.");
    const rows = (
        await executor.run(["rev-list", "--parents", `--max-count=${selected.length}`, "HEAD"])
    )
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/));
    if (
        rows.length !== selected.length ||
        rows.some(
            (row, index) =>
                row.length !== 2 ||
                !selectedSet.has(row[0]) ||
                (index + 1 < rows.length && row[1] !== rows[index + 1][0]),
        )
    ) {
        throw new Error(
            "Select consecutive non-merge commits ending at HEAD; the initial commit cannot be squashed.",
        );
    }
    await requireUnpublished(executor, rows[rows.length - 1][0]);
    const head = rows[0][0];
    const parent = rows[rows.length - 1][1];
    const tree = (await executor.run(["rev-parse", `${head}^{tree}`])).trim();
    const subjects = (await executor.run(["log", "--no-show-signature", "--no-notes", "--no-decorate", "--reverse", "--format=%s", `${parent}..${head}`])).trimEnd().split("\n");
    const commits = rows.map(row => row[0]).reverse().map((hash, i) => ({ hash, subject: subjects[i] ?? "" }));
    return { branch, head, parent, tree, hashes: rows.map(row => row[0]), commits, message: subjects.join("; ") };
}

/** Reuses HEAD's tree so staged, unstaged and untracked files remain untouched. */
export async function applySquash(
    executor: Pick<GitExecutor, "run">,
    plan: SquashPlan,
    message: string,
): Promise<string> {
    await checkTip(executor, plan.branch, plan.head);
    await requireUnpublished(executor, plan.commits[0].hash);
    const checked = await checkedMessage(executor, message);
    // commit-tree does not consult commit.gpgSign itself. Preserve the user's signing preference.
    const signing = await usesCommitSigning(executor);
    const hash = (
        await executor.run([
            "commit-tree",
            plan.tree,
            "-p",
            plan.parent,
            ...(signing ? ["-S"] : []),
            "-m",
            checked,
        ])
    ).trim();
    await moveBranch(executor, plan.branch, plan.head, hash, plan.commits[0].hash, `squash ${plan.hashes.length} commits`);
    return hash;
}

async function checkTip(executor: Reader, branch: string, expected: string) {
    if (await checkedBranch(executor) !== branch || (await executor.run(["rev-parse", "HEAD"])).trim() !== expected) {
        throw new Error("The checked-out branch changed. Select the commits again.");
    }
}

async function moveBranch(executor: Reader, branch: string, from: string, to: string, oldest: string, reason: string) {
    await checkTip(executor, branch, from);
    await requireUnpublished(executor, oldest);
    await executor.run(["update-ref", "-m", `IntelliGit: ${reason}`, branch, to, from]);
}

export interface RewriteReceipt {
    branch: string;
    before: string;
    after: string;
    firstRewritten: string;
}

export async function undoRewrite(executor: Reader, receipt: RewriteReceipt) {
    await moveBranch(executor, receipt.branch, receipt.after, receipt.before, receipt.firstRewritten, "undo local history edit");
}

export async function prepareReword(executor: Reader, target: string) {
    if (!/^[a-f0-9]{7,40}$/i.test(target)) throw new Error("Invalid commit.");
    const branch = await checkedBranch(executor);
    const head = (await executor.run(["rev-parse", "HEAD"])).trim();
    const [hash, parent, ...otherParents] = (await executor.run(["rev-list", "--parents", "-1", target])).trim().split(/\s+/);
    if (otherParents.length) throw new Error("Select a non-merge commit.");
    await requireUnpublished(executor, hash);
    try {
        await executor.run(["merge-base", "--is-ancestor", hash, head]);
    } catch {
        throw new Error("Select a commit on the current branch.");
    }
    // Read messages without notes, signatures or decorations; -z preserves multiline bodies.
    const raw = await executor.run(["log", "-z", "--reverse", "--no-show-signature", "--no-notes", "--no-decorate",
        "--encoding=UTF-8", "--format=%H%x00%P%x00%T%x00%an%x00%ae%x00%ai%x00%s%x00%B", parent ? `${parent}..${head}` : head, "--"]);
    const fields = raw.split("\0");
    if (fields.pop() !== "" || fields.length % 8 !== 0) throw new Error("Could not read commit metadata.");
    const commits = [];
    let expectedParent = parent ?? "";
    for (let i = 0; i < fields.length; i += 8) {
        const [id, parents, tree, author, email, date, subject, message] = fields.slice(i, i + 8);
        if (parents !== expectedParent) throw new Error("Editing across a merge is not supported. Select a commit after the merge.");
        commits.push({ hash: id, parent: parents, tree, author, email, date, subject, message });
        expectedParent = id;
    }
    if (commits[0]?.hash !== hash || expectedParent !== head) throw new Error("The branch history changed.");
    return { branch, head, parent, commits, message: commits[0].message.replace(/\n$/, "") };
}

export async function applyReword(
    executor: Pick<GitExecutor, "run" | "writeCommit">,
    plan: Awaited<ReturnType<typeof prepareReword>>,
    message: string,
): Promise<RewriteReceipt> {
    await checkTip(executor, plan.branch, plan.head);
    await requireUnpublished(executor, plan.commits[0].hash);
    const checked = await checkedMessage(executor, message);
    const signing = await usesCommitSigning(executor);
    let parent = plan.parent;
    let firstRewritten = "";
    for (const [index, commit] of plan.commits.entries()) {
        const raw = await executor.run(["cat-file", "commit", commit.hash]);
        const headers = raw.slice(0, raw.indexOf("\n\n"));
        const originalParents = [...headers.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]);
        if (originalParents.join(" ") !== commit.parent) throw new Error("The original commit parents are unavailable in this checkout.");
        const sign = signing || /^gpgsig(?:-sha256)? /m.test(headers);
        parent = await executor.writeCommit(
            commit.tree, parent, index === 0 ? checked : commit.message,
            { name: commit.author, email: commit.email, date: commit.date }, sign,
        );
        if (index === 0) firstRewritten = parent;
    }
    await moveBranch(executor, plan.branch, plan.head, parent, plan.commits[0].hash, "edit commit message");
    return { branch: plan.branch, before: plan.head, after: parent, firstRewritten };
}
