import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFeeds, defaultFeedPaths, type FeedPaths, seedMutants } from "./feeds.js";
import { appendTestEvent, type TestEvent } from "./test-events.js";

let dir = "";
let paths: FeedPaths;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "viz-feeds-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	paths = defaultFeedPaths(dir);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const MANIFEST = JSON.stringify({
	files: {
		"src/a.ts": {
			sym: {
				qualifiedName: "doThing",
				mutants: { m1: { mutantId: "m1", status: "survived", mutator: "BooleanLiteral" } },
			},
		},
	},
});

describe("defaultFeedPaths", () => {
	it("puts every feed under the project's .interlinked dir", () => {
		const p = defaultFeedPaths("/proj");
		expect(p.activity).toBe(join("/proj", ".interlinked", "activity.jsonl"));
		expect(p.checkResults).toBe(join("/proj", ".interlinked", "check-results.jsonl"));
		expect(p.testEvents).toBe(join("/proj", ".interlinked", "test-events.jsonl"));
		expect(p.mutationManifest).toBe(join("/proj", ".interlinked", "mutation-manifest.json"));
	});
});

describe("seedMutants", () => {
	it("frames the manifest's current state as born events", () => {
		writeFileSync(paths.mutationManifest, MANIFEST);
		expect(seedMutants(paths.mutationManifest)).toEqual([
			{ kind: "born", mutant: expect.objectContaining({ id: "m1", status: "survived" }) },
		]);
	});

	it("returns nothing when there is no manifest", () => {
		expect(seedMutants(paths.mutationManifest)).toEqual([]);
	});
});

describe("buildFeeds", () => {
	it("exposes one feed per lens on distinct routes", () => {
		const routes = buildFeeds(paths, 1000).map((f) => f.route);
		expect(routes).toEqual(["/api/stream", "/api/checks", "/api/tests", "/api/agents", "/api/mutants"]);
		expect(new Set(routes).size).toBe(routes.length);
	});

	it("gives every feed a non-empty hello label", () => {
		for (const feed of buildFeeds(paths, 1000)) expect(feed.hello.length).toBeGreaterThan(0);
	});

	it("seeds each feed as an empty array when no data files exist", () => {
		for (const feed of buildFeeds(paths, 1000)) expect(feed.seed()).toEqual([]);
	});

	it("seeds the test feed from the on-disk backlog, oldest first", () => {
		const base: TestEvent = { ts: "2026-08-04T00:00:00.000Z", kind: "test", run_id: "r1", status: "pass" };
		appendTestEvent(paths.testEvents, { ...base, name: "first" });
		appendTestEvent(paths.testEvents, { ...base, name: "second" });
		const tests = buildFeeds(paths, 1000).find((f) => f.route === "/api/tests");
		expect(tests?.seed().map((e) => (e as TestEvent).name)).toEqual(["first", "second"]);
	});

	it("folds the activity backlog into one presence per agent", () => {
		const rows = [
			{ ts: "2026-08-05T00:00:00.000Z", type: "tool_use", agent: "session-claude-aaa", tool: "Edit" },
			{ ts: "2026-08-05T00:00:01.000Z", type: "tool_use", agent: "session-codex-bbb", tool: "Read" },
			{ ts: "2026-08-05T00:00:02.000Z", type: "tool_use", agent: "session-claude-aaa", tool: "Write" },
		];
		writeFileSync(paths.activity, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const agents = buildFeeds(paths, 1000).find((f) => f.route === "/api/agents");
		// SAFETY: the /api/agents feed seeds AgentPresence rows; the feed contract
		// erases the element type to `unknown`, so this restores the known shape.
		const seeded = agents?.seed() as Array<{ id: string; edits: number; runner: string }>;
		expect(seeded.map((a) => a.id).sort()).toEqual(["session-claude-aaa", "session-codex-bbb"]);
		expect(seeded.find((a) => a.id === "session-claude-aaa")).toMatchObject({ edits: 2, runner: "claude" });
	});

	it("delivers newly appended test events to a subscriber", () => {
		vi.useFakeTimers();
		try {
			const feed = buildFeeds(paths, 100).find((f) => f.route === "/api/tests");
			const seen: unknown[] = [];
			const sub = feed?.subscribe((ev) => seen.push(ev));
			appendTestEvent(paths.testEvents, {
				ts: "2026-08-04T00:00:01.000Z",
				kind: "test",
				run_id: "r1",
				name: "live",
				status: "fail",
			});
			vi.advanceTimersByTime(1000);
			sub?.stop();
			expect(seen).toEqual([expect.objectContaining({ name: "live", status: "fail" })]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops delivering once a subscription is stopped", () => {
		vi.useFakeTimers();
		try {
			const feed = buildFeeds(paths, 100).find((f) => f.route === "/api/mutants");
			const seen: unknown[] = [];
			const sub = feed?.subscribe((ev) => seen.push(ev));
			sub?.stop();
			writeFileSync(paths.mutationManifest, MANIFEST);
			vi.advanceTimersByTime(3000);
			expect(seen).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
