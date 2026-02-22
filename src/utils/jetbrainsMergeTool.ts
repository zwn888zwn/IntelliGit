import * as os from "os";
import * as path from "path";
import { promises as fsp } from "fs";
import { spawn } from "child_process";

export interface JetBrainsMergeToolLaunchInput {
    binaryPath: string;
    repoRootFsPath: string;
    relativeFilePath: string;
    outputFileFsPath: string;
    baseContent: string;
    oursContent: string;
    theirsContent: string;
}

export interface JetBrainsMergeToolLaunchResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

function sanitizeFileNamePart(value: string): string {
    return value.replace(/[^\w.-]+/g, "_");
}

function buildTempFileNames(relativeFilePath: string): {
    base: string;
    ours: string;
    theirs: string;
} {
    const ext = path.extname(relativeFilePath);
    const baseName = path.basename(relativeFilePath, ext);
    const safe = sanitizeFileNamePart(baseName || "merge");
    const suffix = ext || ".txt";

    return {
        base: `.intelligit-base-${safe}${suffix}`,
        ours: `.intelligit-ours-${safe}${suffix}`,
        theirs: `.intelligit-theirs-${safe}${suffix}`,
    };
}

export function containsConflictMarkers(text: string): boolean {
    return /^(<{7}|={7}|>{7})/m.test(text);
}

export async function launchJetBrainsMergeTool(
    input: JetBrainsMergeToolLaunchInput,
): Promise<JetBrainsMergeToolLaunchResult> {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "intelligit-merge-"));
    const names = buildTempFileNames(input.relativeFilePath);
    const basePath = path.join(tempRoot, names.base);
    const oursPath = path.join(tempRoot, names.ours);
    const theirsPath = path.join(tempRoot, names.theirs);

    try {
        await Promise.all([
            fsp.writeFile(basePath, input.baseContent, "utf8"),
            fsp.writeFile(oursPath, input.oursContent, "utf8"),
            fsp.writeFile(theirsPath, input.theirsContent, "utf8"),
        ]);

        await fsp.mkdir(path.dirname(input.outputFileFsPath), { recursive: true });

        const args = ["merge", oursPath, theirsPath, basePath, input.outputFileFsPath];

        const result = await new Promise<JetBrainsMergeToolLaunchResult>((resolve, reject) => {
            const child = spawn(input.binaryPath, args, {
                cwd: input.repoRootFsPath,
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
            });

            let stderr = "";
            child.stderr?.on("data", (chunk) => {
                stderr += String(chunk);
            });

            child.on("error", (err) => {
                reject(
                    new Error(
                        `Failed to launch JetBrains merge tool '${input.binaryPath}': ${err.message}`,
                    ),
                );
            });

            child.on("close", (exitCode, signal) => {
                if (exitCode !== 0 && exitCode !== null && stderr.trim()) {
                    reject(
                        new Error(
                            `JetBrains merge tool exited with code ${exitCode}: ${stderr.trim()}`,
                        ),
                    );
                    return;
                }
                resolve({ exitCode, signal });
            });
        });

        return result;
    } finally {
        // Assumes the JetBrains CLI blocks until the merge tool closes, which matches
        // the behavior expected by the external-tool wrapper pattern this is based on.
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

