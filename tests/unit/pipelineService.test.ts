import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineService, matchPipelineRemote } from "../../src/services/pipelineService";
import type { Commit } from "../../src/types";
import type { RepositoryEntry } from "../../src/services/RepositoryContextService";

const gitlab = { type: "gitlab" as const, url: "https://gitlab.example.test", token: "private-token" };
const github = { type: "github" as const, url: "https://github.com", token: "github-token" };
const commit = (hash = "a", repoRoot = "/repo") => ({ hash, repoRoot }) as Commit;
const repository = (remote = "git@gitlab.example.test:team/repo.git", root = "/repo") => ({
    root, executor: { run: vi.fn(async () => `origin\t${remote} (fetch)\norigin\t${remote} (push)`) },
    gitOps: { getUnpushedCommitHashes: vi.fn(async () => []) },
}) as unknown as RepositoryEntry;
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("pipeline remote matching", () => {
    it("separates public and private services and matches HTTPS and SSH remotes", () => {
        expect(matchPipelineRemote("git@github.com:org/repo.git", [gitlab, github]))
            .toEqual({ provider: github, project: "org/repo" });
        expect(matchPipelineRemote("https://gitlab.example.test/team/sub/repo.git", [github, gitlab]))
            .toEqual({ provider: gitlab, project: "team/sub/repo" });
        expect(matchPipelineRemote("ssh://git@gitlab.example.test:2222/team/repo.git", [gitlab])?.project).toBe("team/repo");
        expect(matchPipelineRemote("https://gitlab.example.test.attacker.test/team/repo.git", [gitlab])).toBeUndefined();
        expect(matchPipelineRemote("/local/repo", [gitlab])).toBeUndefined();
        expect(matchPipelineRemote("https://gitlab.example.test:8443/team/repo.git", [gitlab])).toBeUndefined();
    });

    it("supports self-hosted GitLab URL prefixes", () => {
        const provider = { ...gitlab, url: `${gitlab.url}/gitlab` };
        expect(matchPipelineRemote(`${provider.url}/group/repo.git`, [provider])?.project).toBe("group/repo");
        expect(matchPipelineRemote("git@gitlab.example.test:group/repo.git", [provider])?.project).toBe("group/repo");
        expect(matchPipelineRemote(`${gitlab.url}/different/repo.git`, [provider])).toBeUndefined();
    });
});

describe("pipeline scanning", () => {
    it("does not contact unconfigured hosts or hosts without tokens", async () => {
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService();
        service.configure([{ ...gitlab, token: " " }, { ...github, url: "http://github.com" }]);
        const repo = repository();
        await service.scan([commit()], [repo], vi.fn());
        expect(repo.executor.run).not.toHaveBeenCalled();
        service.configure([github]);
        await service.scan([commit()], [repo], vi.fn());
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("reads the latest GitLab pipeline, caches it, and never forwards tokens to the UI", async () => {
        const fetcher = vi.fn(async () => json([{ id: 12, status: "success", name: "Build" }]));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        const update = vi.fn();
        await service.scan([commit()], [repository()], update);
        await service.scan([commit()], [repository()], update);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toContain("/projects/team%2Frepo/pipelines?sha=a&order_by=id&sort=desc&per_page=1");
        expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { "PRIVATE-TOKEN": "private-token" }, redirect: "error" });
        expect(update.mock.calls[0][0]).toEqual([{ repoRoot: "/repo", hash: "a", pipeline: {
            state: "success", title: "GitLab: Build — success", url: `${gitlab.url}/team/repo/-/pipelines/12`,
        } }]);
        expect(JSON.stringify(update.mock.calls)).not.toContain("private-token");
    });

    it("combines every GitHub checks page with legacy commit status", async () => {
        const fetcher = vi.fn(async (url: string) => new URL(url).searchParams.get("page") === "1"
            ? json({ total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }] })
            : new URL(url).searchParams.get("page") === "2"
                ? json({ total_count: 2, check_runs: [{ status: "completed", conclusion: "failure" }] })
                : json({ total_count: 1, state: "success" }));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([github]);
        const update = vi.fn();
        await service.scan([commit()], [repository("git@github.com:org/repo.git")], update);
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(fetcher.mock.calls.every(([url]) => url.startsWith("https://api.github.com/repos/org/repo/"))).toBe(true);
        expect(update.mock.calls[0][0][0].pipeline.state).toBe("failed");
    });

    it.each(["pending", "failure"])("does not hide a legacy %s status behind successful checks", async (state) => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("check-runs")
            ? json({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] })
            : json({ total_count: 1, state })));
        const service = new PipelineService(); service.configure([github]);
        const update = vi.fn();
        await service.scan([commit()], [repository("https://github.com/org/repo.git")], update);
        expect(update.mock.calls[0][0][0].pipeline.state).toBe(state === "failure" ? "failed" : "pending");
    });

    it("leaves commits without CI empty", async () => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("check-runs")
            ? json({ total_count: 0, check_runs: [] }) : json({ total_count: 0, state: "pending" })));
        const service = new PipelineService(); service.configure([github]);
        const update = vi.fn();
        await service.scan([commit()], [repository("https://github.com/org/repo.git")], update);
        expect(update.mock.calls[0][0][0].pipeline).toBeUndefined();
    });

    it("pauses invalid credentials for the entire instance until settings change", async () => {
        const fetcher = vi.fn(async () => json({ message: "secret server details" }, 401));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        const update = vi.fn();
        await service.scan([commit()], [repository()], update);
        await service.scan([commit("b")], [repository()], update);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0][0][0].pipeline.state).toBe("unknown");
        expect(JSON.stringify(update.mock.calls)).not.toContain("secret server details");
        service.configure([{ ...gitlab, token: "replacement" }]);
        await service.scan([commit()], [repository()], update);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("honors rate-limit cooldowns", async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn(async () => json({}, 429, { "retry-after": "120" }));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        await service.scan([commit()], [repository()], vi.fn());
        vi.setSystemTime(Date.now() + 60_000);
        await service.scan([commit("b")], [repository()], vi.fn());
        expect(fetcher).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + 61_000);
        await service.scan([commit("c")], [repository()], vi.fn());
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("updates active pipelines after the short cache interval", async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn().mockResolvedValueOnce(json([{ id: 1, status: "running" }]))
            .mockResolvedValueOnce(json([{ id: 1, status: "success" }]));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        const update = vi.fn();
        await service.scan([commit()], [repository()], update);
        vi.setSystemTime(Date.now() + 30_001);
        await service.scan([commit()], [repository()], update);
        expect(update.mock.calls[1][0][0].pipeline.state).toBe("success");
    });

    it("limits requests across repositories to four and uses the matching token", async () => {
        let active = 0; let peak = 0;
        const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
            active++; peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 1));
            active--;
            expect(options.headers).toMatchObject({ "PRIVATE-TOKEN": "private-token" });
            return json([]);
        });
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([github, gitlab]);
        await service.scan(Array.from({ length: 12 }, (_, index) => commit(String(index), index < 6 ? "/repo" : "/other")),
            [repository(), repository("https://gitlab.example.test/team/other.git", "/other")], vi.fn());
        expect(fetcher).toHaveBeenCalledTimes(12);
        expect(peak).toBe(4);
    });

    it("discards late responses from an obsolete scan", async () => {
        let resolve!: (response: Response) => void;
        const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        const update = vi.fn();
        const scan = service.scan([commit()], [repository()], update);
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
        service.stop();
        resolve(json([{ id: 1, status: "success" }]));
        await scan;
        expect(update).not.toHaveBeenCalled();
    });

    it("queries shared worktree history once and updates both roots", async () => {
        const fetcher = vi.fn(async () => json([{ id: 1, status: "success" }]));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        const update = vi.fn();
        await service.scan([commit("a", "/repo"), commit("a", "/worktree")],
            [repository(), repository("git@gitlab.example.test:team/repo.git", "/worktree")], update);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0][0].map((item: { repoRoot: string }) => item.repoRoot)).toEqual(["/repo", "/worktree"]);
    });

    it("does not query local unpushed commits", async () => {
        const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
        const repo = repository();
        vi.mocked(repo.gitOps.getUnpushedCommitHashes).mockResolvedValue(["a"]);
        const service = new PipelineService(); service.configure([gitlab]);
        const update = vi.fn();
        await service.scan([commit()], [repo], update);
        expect(fetcher).not.toHaveBeenCalled();
        expect(update.mock.calls[0][0][0].pipeline).toBeUndefined();
    });

    it("rechecks recent commits whose pipeline has not started yet", async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn().mockResolvedValueOnce(json([]))
            .mockResolvedValueOnce(json([{ id: 1, status: "running" }]));
        vi.stubGlobal("fetch", fetcher);
        const service = new PipelineService(); service.configure([gitlab]);
        const recent = { ...commit(), date: new Date().toISOString() };
        const update = vi.fn();
        await service.scan([recent], [repository()], update);
        vi.setSystemTime(Date.now() + 60_001);
        await service.scan([recent], [repository()], update);
        expect(update.mock.calls[1][0][0].pipeline.state).toBe("running");
    });
});
