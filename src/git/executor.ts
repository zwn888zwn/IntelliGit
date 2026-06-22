import { spawn } from "child_process";
import simpleGit, { SimpleGit } from "simple-git";

export class GitExecutor {
    private readonly git: SimpleGit;

    constructor(private readonly repoRoot: string) {
        this.git = simpleGit(repoRoot, { maxConcurrentProcesses: 6 });
    }

    async run(args: string[]): Promise<string> {
        return this.git.raw(["-c", "core.quotepath=false", ...args]);
    }

    async runWithStderr(args: string[]): Promise<string> {
        const gitArgs = ["-c", "core.quotepath=false", ...args];
        return new Promise((resolve, reject) => {
            const child = spawn("git", gitArgs, { cwd: this.repoRoot });
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
}
