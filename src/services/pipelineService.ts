import type { Commit, PipelineStatus } from "../types";
import type { RepositoryEntry } from "./RepositoryContextService";

interface Provider {
    type: "github" | "gitlab";
    url: string;
    token: string;
}

interface Target {
    provider: Provider;
    project: string;
}

type Update = { repoRoot: string; hash: string; pipeline?: PipelineStatus };

// Match service origins exactly; credentials never come from a repository or a webview.
export function matchPipelineRemote(remote: string, providers: Provider[]): Target | undefined {
    try {
        const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(remote);
        const parsed = new URL(remote.includes("://") ? remote : `ssh://${scp?.[1]}/${scp?.[2]}`);
        if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) return;
        for (const provider of providers) {
            const base = new URL(provider.url);
            if (parsed.hostname !== base.hostname) continue;
            if (parsed.protocol !== "ssh:" && parsed.host !== base.host) continue;
            const prefix = base.pathname.replace(/\/$/, "");
            let project = decodeURIComponent(parsed.pathname).replace(/^\//, "").replace(/\.git$/, "");
            if (prefix && parsed.protocol !== "ssh:") {
                if (!parsed.pathname.startsWith(`${prefix}/`)) continue;
                project = project.slice(prefix.length);
            }
            if (project.split("/").some((part) => !part || part === "." || part === "..")) continue;
            if (project.split("/").length < 2) continue;
            return { provider, project };
        }
    } catch {
        // Local paths and unsupported remote formats have no CI provider.
    }
}

export class PipelineService {
    private providers: Provider[] = [];
    private controller?: AbortController;
    private cache = new Map<string, { pipeline?: PipelineStatus; expires: number }>();
    private paused = new Map<string, { until: number; title: string }>();

    configure(value: unknown): void {
        this.stop();
        this.cache.clear();
        this.paused.clear();
        this.providers = [];
        if (!Array.isArray(value)) return;
        for (const item of value) {
            if (!item || !["github", "gitlab"].includes(item.type) ||
                typeof item.url !== "string" || typeof item.token !== "string" || !item.token.trim()) continue;
            try {
                const url = new URL(item.url);
                if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) continue;
                this.providers.push({ type: item.type, url: url.href.replace(/\/$/, ""), token: item.token.trim() });
            } catch {
                // An incomplete settings entry must not break the commit graph.
            }
        }
    }

    get enabled(): boolean {
        return this.providers.length > 0;
    }

    stop(): void {
        this.controller?.abort();
    }

    async scan(commits: Commit[], repositories: RepositoryEntry[], onUpdate: (updates: Update[]) => void): Promise<void> {
        this.stop();
        const controller = new AbortController();
        this.controller = controller;
        const { signal } = controller;
        if (!this.enabled) return;
        const grouped = new Map<string, { commits: Commit[]; target: Target }>();
        const pending: Update[] = [];
        for (const entry of repositories) {
            const repoCommits = commits.filter((commit) => commit.repoRoot === entry.root);
            if (!repoCommits.length || signal.aborted) continue;
            try {
                const remotes = (await entry.executor.run(["remote", "-v"]))
                    .split("\n").map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim()))
                    .filter((remote): remote is RegExpExecArray => Boolean(remote))
                    .sort((a, b) => Number(b[1] === "origin") - Number(a[1] === "origin"));
                const target = remotes.map((remote) => matchPipelineRemote(remote[2], this.providers)).find(Boolean);
                if (target) {
                    const unpushed = new Set(await entry.gitOps.getUnpushedCommitHashes().catch(() => []));
                    for (const commit of repoCommits) {
                        if (unpushed.has(commit.hash)) {
                            pending.push({ repoRoot: commit.repoRoot, hash: commit.hash });
                            continue;
                        }
                        const key = `${target.provider.type}:${target.provider.url}/${target.project}:${commit.hash}`;
                        const job = grouped.get(key);
                        if (job) job.commits.push(commit);
                        else grouped.set(key, { commits: [commit], target });
                    }
                }
            } catch {
                // Removed repositories must not prevent other repositories from updating.
            }
        }
        let index = 0;
        const jobs = Array.from(grouped.entries());
        const flush = (): void => {
            if (!signal.aborted && pending.length) onUpdate(pending.splice(0));
        };
        const timer = setInterval(flush, 100);
        // One queue across all repositories, including both GitHub endpoints.
        try {
            await Promise.all(Array.from({ length: 4 }, async () => {
                while (!signal.aborted && index < jobs.length) {
                    const [key, { commits: matches, target }] = jobs[index++];
                    const commit = matches[0];
                    const cached = this.cache.get(key);
                    let pipeline = cached?.pipeline;
                    if (!cached || cached.expires <= Date.now()) {
                        try {
                            pipeline = await this.readStatus(target, commit.hash, signal);
                        } catch {
                            pipeline = { state: "unknown", title: this.paused.get(target.provider.url)?.title
                                ?? "CI status unavailable. Check the service connection and token permissions." };
                        }
                        if (signal.aborted) return;
                        const active = pipeline && ["running", "pending", "unknown"].includes(pipeline.state);
                        // Recently created commits may not have started CI yet.
                        const awaitingStart = !pipeline && Date.now() - Date.parse(commit.date) < 3_600_000;
                        this.cache.set(key, { pipeline, expires: Date.now() + (active ? 30_000 : awaitingStart ? 60_000 : 900_000) });
                        if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
                    }
                    pending.push(...matches.map((item) => ({ repoRoot: item.repoRoot, hash: item.hash, pipeline })));
                }
            }));
        } finally {
            clearInterval(timer);
            flush();
        }
    }

    private async request<T>(provider: Provider, path: string, signal: AbortSignal): Promise<T> {
        const paused = this.paused.get(provider.url);
        if (paused && paused.until > Date.now()) throw new Error(paused.title);
        const api = provider.type === "gitlab" ? `${provider.url}/api/v4`
            : provider.url === "https://github.com" ? "https://api.github.com" : `${provider.url}/api/v3`;
        const response = await fetch(`${api}${path}`, {
            headers: provider.type === "gitlab"
                ? { "PRIVATE-TOKEN": provider.token }
                : { Authorization: `Bearer ${provider.token}`, Accept: "application/vnd.github+json" },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        signal.throwIfAborted();
        if (!response.ok) {
            if ([401, 403, 429].includes(response.status)) {
                const retryAfter = Number(response.headers.get("retry-after")) || 60;
                const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
                const limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
                this.paused.set(provider.url, {
                    until: limited ? Math.max(Date.now() + retryAfter * 1000, resetAt || 0) : Infinity,
                    title: limited ? "CI API rate limit reached; waiting to retry."
                        : "CI authentication or permission denied. Update pipeline.providers to retry.",
                });
            }
            // Do not expose server responses, request headers, or tokens in errors.
            throw new Error(`CI request failed (${response.status})`);
        }
        return await response.json() as T;
    }

    private async readStatus(target: Target, hash: string, signal: AbortSignal): Promise<PipelineStatus | undefined> {
        const { provider, project } = target;
        const projectPath = project.split("/").map(encodeURIComponent).join("/");
        if (provider.type === "gitlab") {
            const pipelines = await this.request<Array<{ id: number; status: string; name?: string }>>(
                provider, `/projects/${encodeURIComponent(project)}/pipelines?sha=${encodeURIComponent(hash)}&order_by=id&sort=desc&per_page=1`, signal,
            );
            const pipeline = pipelines[0];
            if (!pipeline) return;
            const states: Record<string, PipelineStatus["state"]> = {
                success: "success", failed: "failed", running: "running", pending: "pending",
                created: "pending", waiting_for_resource: "pending", preparing: "pending",
                manual: "pending", scheduled: "pending", canceled: "canceled", skipped: "skipped",
            };
            return {
                state: states[pipeline.status] ?? "unknown",
                title: `GitLab: ${pipeline.name || `Pipeline #${pipeline.id}`} — ${pipeline.status}`,
                url: `${provider.url}/${projectPath}/-/pipelines/${encodeURIComponent(pipeline.id)}`,
            };
        }

        const path = `/repos/${projectPath}/commits/${encodeURIComponent(hash)}`;
        const states: PipelineStatus["state"][] = [];
        let page = 1;
        let total = 0;
        for (;;) {
            const checks = await this.request<{
                total_count: number;
                check_runs: Array<{ status: string; conclusion: string | null }>;
            }>(provider, `${path}/check-runs?filter=latest&per_page=100&page=${page}`, signal);
            for (const check of checks.check_runs) {
                states.push(check.status !== "completed"
                    ? check.status === "in_progress" ? "running" : "pending"
                    : check.conclusion === "success" ? "success"
                    : ["neutral", "skipped"].includes(check.conclusion ?? "") ? "skipped"
                    : check.conclusion === "cancelled" ? "canceled"
                    : ["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(check.conclusion ?? "") ? "failed" : "unknown");
            }
            total += checks.check_runs.length;
            if (total >= checks.total_count || checks.check_runs.length === 0) break;
            page++;
        }
        const status = await this.request<{ total_count: number; state: string }>(provider, `${path}/status`, signal);
        if (status.total_count > 0) {
            states.push(status.state === "success" ? "success" : status.state === "pending" ? "pending"
                : ["failure", "error"].includes(status.state) ? "failed" : "unknown");
        }
        if (!states.length) return;
        const state = (["failed", "running", "pending", "unknown", "canceled"] as const).find((value) => states.includes(value))
            ?? (states.includes("success") ? "success" : "skipped");
        return { state, title: `GitHub checks: ${state}`, url: `${provider.url}/${projectPath}/commit/${hash}/checks` };
    }
}
