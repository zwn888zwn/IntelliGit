import * as os from "os";
import * as path from "path";
import { promises as fsp, constants as fsConstants } from "fs";
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

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function isExecutableFile(filePath: string): Promise<boolean> {
    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) return false;
        await fsp.access(filePath, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function isMacAppBundlePath(inputPath: string): boolean {
    return process.platform === "darwin" && inputPath.toLowerCase().endsWith(".app");
}

function parseBundleExecutableName(infoPlistContent: string): string | null {
    const match = infoPlistContent.match(
        /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/s,
    );
    return match?.[1]?.trim() || null;
}

async function resolveExecutableFromMacAppBundle(appBundlePath: string): Promise<string> {
    const contentsDir = path.join(appBundlePath, "Contents");
    const macOsDir = path.join(contentsDir, "MacOS");
    const infoPlistPath = path.join(contentsDir, "Info.plist");

    if (!(await pathExists(appBundlePath))) {
        throw new Error(`JetBrains app bundle not found: ${appBundlePath}`);
    }

    try {
        const plist = await fsp.readFile(infoPlistPath, "utf8");
        const executableName = parseBundleExecutableName(plist);
        if (executableName) {
            const executablePath = path.join(macOsDir, executableName);
            if (await isExecutableFile(executablePath)) {
                return executablePath;
            }
        }
    } catch {
        // Fall back to scanning Contents/MacOS if Info.plist parsing fails.
    }

    let entries: string[] = [];
    try {
        entries = await fsp.readdir(macOsDir);
    } catch {
        throw new Error(
            `Could not locate executable inside app bundle '${appBundlePath}' (missing Contents/MacOS).`,
        );
    }

    const preferredNames = new Set([
        "pycharm",
        "idea",
        "webstorm",
        "phpstorm",
        "rubymine",
        "clion",
        "goland",
        "datagrip",
        "dataspell",
        "rider",
        "aqua",
    ]);

    const candidatePaths = entries
        .filter((name) => !name.startsWith("."))
        .sort((a, b) => {
            const aPreferred = preferredNames.has(a.toLowerCase()) ? 1 : 0;
            const bPreferred = preferredNames.has(b.toLowerCase()) ? 1 : 0;
            return bPreferred - aPreferred || a.localeCompare(b);
        })
        .map((name) => path.join(macOsDir, name));

    for (const candidate of candidatePaths) {
        if (await isExecutableFile(candidate)) return candidate;
    }

    throw new Error(
        `No executable file found inside '${appBundlePath}/Contents/MacOS'. Provide the binary path directly.`,
    );
}

export async function resolveJetBrainsMergeBinaryPath(binaryPath: string): Promise<string> {
    const trimmed = binaryPath.trim();
    if (!trimmed) {
        throw new Error("JetBrains merge tool path is empty.");
    }

    if (isMacAppBundlePath(trimmed)) {
        return resolveExecutableFromMacAppBundle(trimmed);
    }

    return trimmed;
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
    const resolvedBinaryPath = await resolveJetBrainsMergeBinaryPath(input.binaryPath);
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
            const child = spawn(resolvedBinaryPath, args, {
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
