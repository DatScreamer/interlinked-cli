import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectCodexSessions, findCodexRollouts } from "./codex-collect.js";

const roots: string[] = [];
afterAll(() => {
	// best-effort; OS reaps tmp
});

function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	roots.push(d);
	return d;
}

function rollout(session: string): string {
	return [
		{ timestamp: "2026-07-18T18:40:04Z", type: "session_meta", payload: { session_id: session, cwd: "/r" } },
		{ timestamp: "2026-07-18T18:40:05Z", type: "response_item", payload: { type: "turn_context", model: "oai-model-v6" } },
		{ timestamp: "2026-07-18T18:40:06Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Review." }] } },
		{ timestamp: "2026-07-18T18:40:16Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
	]
		.map((e) => JSON.stringify(e))
		.join("\n");
}

describe("findCodexRollouts", () => {
	it("finds rollout files recursively and honors --since mtime", () => {
		const dir = tmp("codex-find-");
		const day = join(dir, "2026", "07", "18");
		mkdirSync(day, { recursive: true });
		const old = join(day, "rollout-old.jsonl");
		const recent = join(day, "rollout-recent.jsonl");
		writeFileSync(old, rollout("s-old"));
		writeFileSync(recent, rollout("s-recent"));
		writeFileSync(join(day, "notes.txt"), "ignore me");
		const t0 = new Date("2026-07-18T00:00:00Z");
		utimesSync(old, t0, t0); // backdate the old file
		expect(findCodexRollouts(dir).sort()).toEqual([old, recent].sort());
		expect(findCodexRollouts(dir, Date.now() - 60_000)).toEqual([recent]);
		expect(findCodexRollouts(join(dir, "does-not-exist"))).toEqual([]);
	});
});

describe("collectCodexSessions", () => {
	const setup = () => {
		const dir = tmp("codex-src-");
		const cwd = tmp("codex-cwd-");
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const day = join(dir, "2026", "07", "18");
		mkdirSync(day, { recursive: true });
		writeFileSync(join(day, "rollout-a.jsonl"), rollout("sess-a"));
		writeFileSync(join(day, "rollout-b.jsonl"), rollout("sess-b"));
		return { dir, cwd };
	};

	it("appends normalized codex records to timeline.jsonl", () => {
		const { dir, cwd } = setup();
		const r = collectCodexSessions({ cwd, dir });
		expect(r.files).toBe(2);
		expect(r.sessions).toBe(2);
		expect(r.added).toBe(r.parsed);
		expect(r.added).toBeGreaterThan(0);
		const lines = readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8").trim().split("\n");
		const recs = lines.map((l) => JSON.parse(l));
		expect(recs.every((x) => x.provider === "codex")).toBe(true);
		expect(recs.some((x) => x.category === "user_prompt" && x.text === "Review.")).toBe(true);
		expect(recs.some((x) => x.category === "agent_message" && x.model === "oai-model-v6")).toBe(true);
	});

	it("is idempotent — a second run appends nothing", () => {
		const { dir, cwd } = setup();
		const first = collectCodexSessions({ cwd, dir });
		const second = collectCodexSessions({ cwd, dir });
		expect(first.added).toBeGreaterThan(0);
		expect(second.added).toBe(0);
		expect(second.parsed).toBe(first.parsed); // still parses, just dedups
	});

	it("dryRun reports counts without writing", () => {
		const { dir, cwd } = setup();
		const r = collectCodexSessions({ cwd, dir, dryRun: true });
		expect(r.added).toBeGreaterThan(0);
		let wrote = true;
		try {
			readFileSync(join(cwd, ".interlinked", "timeline.jsonl"), "utf8");
		} catch {
			wrote = false;
		}
		expect(wrote).toBe(false);
	});
});
