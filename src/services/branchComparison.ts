import type { GitExecutor } from "../git/executor";

/** Pin both endpoints before reading files; never mix a refreshed HEAD with an old list. */
export async function resolveBranchChanges(executor: GitExecutor, branch: string): Promise<{
    base: string; head: string;
}> {
    const resolve = async (ref: string) => {
        const hash = (await executor.run(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
        if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error(`无法解析提交：${ref}`);
        return hash;
    };
    const [other, head] = await Promise.all([resolve(branch), resolve("HEAD")]);
    let output: string;
    try {
        output = await executor.run(["merge-base", "--all", other, head]);
    } catch {
        throw new Error(`当前分支与 ${branch} 没有可用的共同祖先。`);
    }
    const bases = output.trim().split(/\s+/).filter(Boolean);
    if (bases.length !== 1 || !/^[0-9a-f]{40,64}$/.test(bases[0])) {
        throw new Error(bases.length > 1
            ? "这两个分支有多个共同祖先，请使用普通分支比较。"
            : `当前分支与 ${branch} 没有可用的共同祖先。`);
    }
    return { base: bases[0], head };
}
