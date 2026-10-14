import { existsSync } from "fs";
import type { GitExecutor } from "./executor";

export interface SquashPlan {
    branch: string;
    head: string;
    parent: string;
    tree: string;
    hashes: string[];
    message: string;
}

/** Only a consecutive, unpublished suffix of the checked-out branch may be squashed. */
export async function prepareSquash(
    executor: Pick<GitExecutor, "run">,
    hashes: string[],
): Promise<SquashPlan> {
    if (
        !Array.isArray(hashes) ||
        hashes.length < 2 ||
        hashes.length > 500 ||
        hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{7,40}$/i.test(hash))
    ) {
        throw new Error("Select at least two consecutive unpushed commits through HEAD.");
    }
    for (const marker of [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_LOG",
    ]) {
        const markerPath = (
            await executor.run(["rev-parse", "--path-format=absolute", "--git-path", marker])
        ).trim();
        if (existsSync(markerPath))
            throw new Error("Finish the current Git operation before squashing commits.");
    }
    const branch = (await executor.run(["symbolic-ref", "--quiet", "HEAD"])).trim();
    const selected = await Promise.all(
        hashes.map(async (hash) =>
            (await executor.run(["rev-parse", "--verify", `${hash}^{commit}`])).trim(),
        ),
    );
    if (new Set(selected).size !== selected.length)
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
                !selected.includes(row[0]) ||
                (index + 1 < rows.length && row[1] !== rows[index + 1][0]),
        )
    ) {
        throw new Error(
            "Select consecutive non-merge commits ending at HEAD; the initial commit cannot be squashed.",
        );
    }
    const unpushed = new Set(
        (await executor.run(["rev-list", "HEAD", "--not", "--remotes"])).trim().split("\n"),
    );
    if (selected.some((hash) => !unpushed.has(hash))) {
        throw new Error(
            "Squash is available only for commits not present on a remote-tracking branch.",
        );
    }
    const head = rows[0][0];
    const parent = rows[rows.length - 1][1];
    const tree = (await executor.run(["rev-parse", `${head}^{tree}`])).trim();
    const message = (await executor.run(["log", "--reverse", "--format=%s", `${parent}..${head}`]))
        .trim()
        .split("\n")
        .join("; ");
    return { branch, head, parent, tree, hashes: rows.map((row) => row[0]), message };
}

/** Reuses HEAD's tree so staged, unstaged and untracked files remain untouched. */
export async function applySquash(
    executor: Pick<GitExecutor, "run">,
    plan: SquashPlan,
    message: string,
): Promise<string> {
    if (!message.trim() || message.includes("\0")) throw new Error("Enter a valid commit message.");
    const current = await prepareSquash(executor, plan.hashes);
    if (current.head !== plan.head || current.branch !== plan.branch) {
        throw new Error("The checked-out branch changed. Select the commits again.");
    }
    // commit-tree does not consult commit.gpgSign itself. Preserve the user's signing preference.
    const signing =
        (
            await executor.run(["config", "--default=false", "--bool", "--get", "commit.gpgsign"])
        ).trim() === "true";
    const hash = (
        await executor.run([
            "commit-tree",
            plan.tree,
            "-p",
            plan.parent,
            ...(signing ? ["-S"] : []),
            "-m",
            message,
        ])
    ).trim();
    if ((await executor.run(["symbolic-ref", "--quiet", "HEAD"])).trim() !== plan.branch) {
        throw new Error("The checked-out branch changed. No branch was rewritten.");
    }
    // Compare-and-swap refuses to rewrite a branch that moved while the message/signature was prepared.
    await executor.run([
        "update-ref",
        "-m",
        `IntelliGit: squash ${plan.hashes.length} commits`,
        plan.branch,
        hash,
        plan.head,
    ]);
    return hash;
}
