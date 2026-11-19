import { execFile, spawn } from "child_process";
import simpleGit, { SimpleGit } from "simple-git";

export class GitExecutor {
    private readonly git: SimpleGit;

    constructor(private readonly repoRoot: string) {
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    async run(args: string[]): Promise<string> {
        // Background reads must not contend with merge/stage for the index lock.
        if (args[0] === "status") {
            args = ["--no-optional-locks", ...args];
        } else if (args[0] === "diff") {
            args = ["-c", "diff.autoRefreshIndex=false", ...args];
        }
        return this.git.raw(["-c", "core.quotepath=false", ...args]);
    }

    async runWithStderr(args: string[], indexFile?: string): Promise<string> {
        const gitArgs = ["-c", "core.quotepath=false", ...args];
        return new Promise((resolve, reject) => {
            const child = spawn("git", gitArgs, {
                cwd: this.repoRoot,
                ...(indexFile ? { env: { ...process.env, GIT_INDEX_FILE: indexFile } } : {}),
            });
            let stdout = "";
            let stderr = "";

            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk: string | Buffer) => {
                stdout += chunk.toString();
            });
            child.stderr?.on("data", (chunk: string | Buffer) => {
                stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
                const output = `${stdout}${stderr}`;
                if (code === 0) {
                    resolve(output);
                    return;
                }
                reject(new Error(output.trim() || `git ${args[0]} failed with exit code ${code}`));
            });
        });
    }

    /** Build a commit from an existing tree without reading or modifying the index. */
    writeCommit(tree: string, parent: string | undefined, message: string,
        author: { name: string; email: string; date: string }, sign: boolean): Promise<string> {
        const args = ["-c", "i18n.commitEncoding=UTF-8", "commit-tree", tree];
        if (parent) args.push("-p", parent);
        if (sign) args.push("-S");
        args.push("-F", "-");
        return new Promise((resolve, reject) => {
            const child = execFile("git", args, {
                cwd: this.repoRoot, encoding: "utf8",
                env: { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date },
            }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
            child.stdin?.on("error", reject);
            child.stdin?.end(message.endsWith("\n") ? message : message + "\n");
        });
    }

    /** Read against an editor snapshot without saving it or changing the index. */
    runWithInput(args: string[], input: string, signal?: AbortSignal): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = execFile("git", ["-c", "core.quotepath=false", ...args], {
                cwd: this.repoRoot, encoding: "utf8", timeout: 5000,
                maxBuffer: 32 * 1024 * 1024, signal,
            }, (error, stdout) => error ? reject(error) : resolve(stdout));
            // Git can reject an untracked path before consuming stdin.
            child.stdin?.on("error", () => {});
            child.stdin?.end(input);
        });
    }
}
