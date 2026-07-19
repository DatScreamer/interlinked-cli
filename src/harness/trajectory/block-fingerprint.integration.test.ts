import { describe, expect, it } from "vitest";
import {
	type BlockFingerprint,
	configLooseningAfterBlock,
	escapeEnvAfterBlock,
	fingerprintBlock,
	mostRecentArmed,
	pruneExpired,
	sameContentResurfacing,
	sameTargetDifferentChannel,
} from "./block-fingerprint.js";

// A representative refused probe script — the exact shape this session's own
// `node -e` sidestep took (send a synthetic hook event, print timing).
const REFUSED = `import { spawnSync } from "node:child_process";
const ev = JSON.stringify({ session_id: "x", hook_event_name: "PreToolUse", tool_name: "Bash" });
const r = spawnSync("node", ["dist/hook-entry.js"], { input: ev });
console.log("edit gate", r.status);`;

function fp(over: Partial<Parameters<typeof fingerprintBlock>[0]> = {}): BlockFingerprint {
	return fingerprintBlock({
		ruleId: "scratchpad_guard",
		content: REFUSED,
		target: "scratch/probe.mjs",
		atMs: 1_000,
		...over,
	});
}

describe("fingerprintBlock", () => {
	it("captures rule id, target (POSIX-normalized), timestamp, and non-empty shingles", () => {
		const f = fingerprintBlock({ ruleId: "r", content: REFUSED, target: "a\\b\\c.ts", atMs: 5 });
		expect(f.ruleId).toBe("r");
		expect(f.target).toBe("a/b/c.ts");
		expect(f.atMs).toBe(5);
		expect(f.shingles.size).toBeGreaterThan(0);
	});

	it("null target when the refusal named none", () => {
		expect(fingerprintBlock({ ruleId: "r", content: "x", atMs: 1 }).target).toBeNull();
	});
});

describe("pruneExpired + mostRecentArmed", () => {
	it("drops fingerprints past the TTL, keeps fresh ones", () => {
		const old = fp({ atMs: 0 });
		const fresh = fp({ atMs: 1_000_000 });
		const kept = pruneExpired([old, fresh], 1_000_000, 15 * 60_000);
		expect(kept).toEqual([fresh]);
	});

	it("mostRecentArmed returns the newest, or null when empty", () => {
		expect(mostRecentArmed([])).toBeNull();
		const a = fp({ atMs: 10 });
		const b = fp({ atMs: 99 });
		expect(mostRecentArmed([a, b])).toBe(b);
	});
});

describe("D1 sameContentResurfacing", () => {
	it("fires when a blocked probe reappears verbatim (any channel)", () => {
		expect(sameContentResurfacing([fp()], REFUSED)).not.toBeNull();
	});

	it("fires on a lightly-edited resurrection (survives reformatting)", () => {
		const edited = REFUSED.replace('"x"', '"y"').replace("edit gate", "edit gate ms");
		expect(sameContentResurfacing([fp()], edited)).not.toBeNull();
	});

	it("does NOT fire on unrelated content", () => {
		expect(sameContentResurfacing([fp()], "const total = items.reduce((a, b) => a + b, 0);")).toBeNull();
	});

	it("does NOT fire on empty candidate or empty armed set", () => {
		expect(sameContentResurfacing([fp()], "")).toBeNull();
		expect(sameContentResurfacing([], REFUSED)).toBeNull();
	});
});

describe("D2 sameTargetDifferentChannel", () => {
	it("fires when a later write targets the blocked path (redirect/sed -i/tee)", () => {
		expect(sameTargetDifferentChannel([fp()], "scratch/probe.mjs")).not.toBeNull();
		expect(sameTargetDifferentChannel([fp()], "scratch\\probe.mjs")).not.toBeNull();
	});

	it("does NOT fire on a different path or a null-target fingerprint", () => {
		expect(sameTargetDifferentChannel([fp()], "src/other.ts")).toBeNull();
		expect(sameTargetDifferentChannel([fp({ target: null })], "scratch/probe.mjs")).toBeNull();
		expect(sameTargetDifferentChannel([fp()], null)).toBeNull();
	});
});

describe("D3 configLooseningAfterBlock", () => {
	it("fires when config/baseline/settings is edited while a block is armed", () => {
		for (const p of [
			".interlinked/guard-rules.local.json",
			".interlinked/large-files-baseline.json",
			".interlinked/metric-caps.json",
			".claude/settings.json",
		]) {
			expect(configLooseningAfterBlock([fp()], p)).not.toBeNull();
		}
	});

	it("does NOT fire on ordinary source edits or when nothing is armed", () => {
		expect(configLooseningAfterBlock([fp()], "src/harness/server.ts")).toBeNull();
		expect(configLooseningAfterBlock([], ".interlinked/guard-rules.json")).toBeNull();
	});
});

describe("D4 escapeEnvAfterBlock", () => {
	it("fires when an escape env is set while a block is armed", () => {
		for (const c of [
			"INTERLINKED_DISABLE_SCRATCH_GUARD=1 node probe.mjs",
			"INTERLINKED_SKIP_PROJECT_TYPECHECK=1 git commit -m x",
			"INTERLINKED_ALLOW_NO_DAEMON=1 npx tsx src/index.ts status",
		]) {
			expect(escapeEnvAfterBlock([fp()], c)).not.toBeNull();
		}
	});

	it("does NOT fire on ordinary commands or when nothing is armed", () => {
		expect(escapeEnvAfterBlock([fp()], "npm run build")).toBeNull();
		expect(escapeEnvAfterBlock([], "INTERLINKED_DISABLE_SCRATCH_GUARD=1 node x")).toBeNull();
		expect(escapeEnvAfterBlock([fp()], null)).toBeNull();
	});
});
