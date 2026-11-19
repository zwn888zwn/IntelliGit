import type { GitExecutor } from "./executor";

export async function readBranchTracking(executor: GitExecutor, branch: string) {
    const ref = `refs/heads/${branch}`;
    const fields = "%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push:remotename)";
    const output = await executor.run(["for-each-ref", `--format=${fields}`, ref]);
    const row = output.split("\n").map(line => line.split("\0")).find(([name]) => name === ref);
    if (!row) throw new Error(`Local branch '${branch}' no longer exists.`);
    const [, remote, remoteRef, pushRemote] = row;
    if (remote && !remoteRef.startsWith("refs/heads/")) {
        throw new Error(`The upstream of '${branch}' is not a remote branch.`);
    }
    const upstream = remote ? { remote, remoteBranch: remoteRef.slice("refs/heads/".length) } : null;
    return { upstream, pushRemote };
}

export async function firstPushRemote(executor: GitExecutor, branch: string, preferred: string): Promise<string> {
    if (preferred) return preferred;
    const remotes = (await executor.run(["remote"])).trim().split("\n").filter(Boolean);
    if (!remotes.length) throw new Error(`No remote configured for branch ${branch}.`);
    return remotes.includes("origin") ? "origin" : remotes[0];
}
