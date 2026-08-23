import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tree-snapshot.js", () => ({
	loadSnapshotIndex: vi.fn(),
	restoreTree: vi.fn(),
}));
vi.mock("./state-archive.js", () => ({
	loadStateSnapshot: vi.fn(),
}));

import { loadSnapshotIndex, restoreTree } from "./tree-snapshot.js";
import { loadStateSnapshot } from "./state-archive.js";
import { rebuildReservationCacheAt, restoreSessionStep } from "./sandbox-restore.js";

const mockedLoadSnapshotIndex = vi.mocked(loadSnapshotIndex);
const mockedRestoreTree = vi.mocked(restoreTree);
const mockedLoadStateSnapshot = vi.mocked(loadStateSnapshot);

describe("restoreSessionStep — row selection (find ?? fallback, phase/session filters)", () => {
	beforeEach(() => {
		mockedLoadSnapshotIndex.mockReset();
		mockedRestoreTree.mockReset();
		mockedLoadStateSnapshot.mockReset();
		mockedLoadStateSnapshot.mockReturnValue(null);
	});

	it("falls back to rows[0] when no row has phase 'pre' (kills 12cb9fb9 ?? -> &&)", () => {
		mockedLoadSnapshotIndex.mockReturnValue([
			{
				schema: "tree-snapshot.v1",
				session_id: "s1",
				seq: 1,
				tool_use_id: null,
				phase: "post",
				backend: "git",
				tree: "treeA",
				commit: "c1",
				ts: "2020-01-01T00:00:00Z",
			},
		]);
		const summary = restoreSessionStep({
			cwd: "/repo",
			sessionId: "s1",
			seq: 1,
			destDir: "/dest",
		});
		expect(summary.tree).toBe("treeA");
		expect(mockedRestoreTree).toHaveBeenCalledWith("/repo", "treeA", "/dest");
	});

	it("filters strictly by session_id (kills 9e6eec25 session_id -> true)", () => {
		mockedLoadSnapshotIndex.mockReturnValue([
			{
				schema: "tree-snapshot.v1",
				session_id: "other-session",
				seq: 5,
				tool_use_id: null,
				phase: "pre",
				backend: "git",
				tree: "WRONG_TREE",
				commit: "c1",
				ts: "2020-01-01T00:00:00Z",
			},
			{
				schema: "tree-snapshot.v1",
				session_id: "target-session",
				seq: 5,
				tool_use_id: null,
				phase: "pre",
				backend: "git",
				tree: "RIGHT_TREE",
				commit: "c2",
				ts: "2020-01-01T00:00:01Z",
			},
		]);
		const summary = restoreSessionStep({
			cwd: "/repo",
			sessionId: "target-session",
			seq: 5,
			destDir: "/dest",
		});
		expect(summary.tree).toBe("RIGHT_TREE");
	});

	it("prefers the 'pre' phase row over an earlier non-pre row (kills 09a67f26/ba29eb85/c76a7d81/eb0eac2b/a915ce4e)", () => {
		mockedLoadSnapshotIndex.mockReturnValue([
			{
				schema: "tree-snapshot.v1",
				session_id: "s1",
				seq: 2,
				tool_use_id: null,
				phase: "post",
				backend: "git",
				tree: "POST_TREE",
				commit: "c1",
				ts: "2020-01-01T00:00:00Z",
			},
			{
				schema: "tree-snapshot.v1",
				session_id: "s1",
				seq: 2,
				tool_use_id: null,
				phase: "pre",
				backend: "git",
				tree: "PRE_TREE",
				commit: "c2",
				ts: "2020-01-01T00:00:01Z",
			},
		]);
		const summary = restoreSessionStep({
			cwd: "/repo",
			sessionId: "s1",
			seq: 2,
			destDir: "/dest",
		});
		expect(summary.tree).toBe("PRE_TREE");
	});
});

describe("rebuildReservationCacheAt — line/JSON filtering + cutoff comparison", () => {
	let dir: string;
	let eventsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sandbox-restore-w43-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		eventsPath = join(dir, ".interlinked", "reservation-events.jsonl");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeLines(lines: string[]): void {
		writeFileSync(eventsPath, `${lines.join("\n")}\n`, "utf-8");
	}

	it("returns an empty map when the log file does not exist", () => {
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.size).toBe(0);
	});

	it("drops a grant row with a non-string file (kills c62b5aa8 typeof file -> true)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: 123,
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.size).toBe(0);
	});

	it("drops a grant row with a non-string agent_name (kills 4bc5a9a3 typeof agent -> true)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: 42,
				ts: "2020-01-01T00:00:00Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.size).toBe(0);
	});

	it("drops a grant row whose file coerces to empty string (kills 311c77b8 && and 2502d6cd ->false)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.size).toBe(0);
	});

	it("uses row.ts verbatim as reserved_at when it is a valid string, and row.expires_at when valid (kills 658732bd, e8bf74d9, 1b6d55b7, and one StringLiteral survivor)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
				expires_at: "2020-02-01T00:00:00Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		const entry = cache.get("foo.ts");
		expect(entry).toBeDefined();
		expect(entry?.reserved_at).toBe("2020-01-01T00:00:00Z");
		expect(entry?.expires_at).toBe("2020-02-01T00:00:00Z");
	});

	it("falls back expires_at to ts when row.expires_at is not a string (kills 7fd1c154 typeof expires_at -> true)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
				expires_at: 999,
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.get("foo.ts")?.expires_at).toBe("2020-01-01T00:00:00Z");
	});

	it("picks grant_local when cohort is not 'remote' (kills d1e969c1 cohort==='remote' -> true)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
				cohort: "local",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.get("foo.ts")?.cohort).toBe("local");
	});

	it("release only removes the targeted file, leaving other grants for the same agent intact (kills 07ff6a8c release-case removal)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
			}),
			JSON.stringify({
				action: "grant",
				file: "bar.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:01Z",
			}),
			JSON.stringify({
				action: "release",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:02Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.has("foo.ts")).toBe(false);
		expect(cache.has("bar.ts")).toBe(true);
	});

	it("release_all requires action to spell exactly (kills a802dcec 'release_all' -> '')", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
			}),
			JSON.stringify({
				action: "grant",
				file: "bar.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:01Z",
			}),
			JSON.stringify({
				action: "release_all",
				agent_name: "bob",
				ts: "2020-01-01T00:00:02Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2099-01-01T00:00:00Z");
		expect(cache.size).toBe(0);
	});

	it("rows with a non-string ts are always excluded regardless of the cutoff comparison (kills 47463cb4 typeof-ts-check -> false)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
			}),
			// numeric ts: type check should exclude this row unconditionally, even
			// though "1" as a number compared against a huge cutoff string would
			// read as within range if the type-check were neutralized.
			JSON.stringify({
				action: "release_all",
				agent_name: "bob",
				ts: 1,
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "99999999999999");
		expect(cache.has("foo.ts")).toBe(true);
	});

	it("cutoff comparison is inclusive of ts === cutoffTs (kills 8dd972eb > -> >=)", () => {
		writeLines([
			JSON.stringify({
				action: "grant",
				file: "foo.ts",
				agent_name: "bob",
				ts: "2020-01-01T00:00:00Z",
			}),
			JSON.stringify({
				action: "release_all",
				agent_name: "bob",
				ts: "2020-06-01T00:00:00Z",
			}),
		]);
		const cache = rebuildReservationCacheAt(dir, "2020-06-01T00:00:00Z");
		expect(cache.has("foo.ts")).toBe(false);
	});
});
