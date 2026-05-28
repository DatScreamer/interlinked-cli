import { describe, expect, it } from "vitest";
import type { CloudVerdict } from "../../lib/cloud-governor.js";
import { isMetaTestWrapper, mergeCloudVerdict } from "../cloud-forward.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command: "ls" },
		timestamp: "2026-05-28T00:00:00Z",
		...overrides,
	};
}

const ALLOW_LOCAL: HarnessDecision = { decision: "allow" };
const ALLOW_LOCAL_WITH_WARNINGS: HarnessDecision = {
	decision: "allow",
	warnings: ["[interlinked] local warn"],
};
const BLOCK_LOCAL: HarnessDecision = {
	decision: "block",
	reason: "blocked locally",
};
const ASK_LOCAL: HarnessDecision = { decision: "ask", reason: "asking" };

describe("mergeCloudVerdict", () => {
	it("returns local unchanged when cloud verdict is null", () => {
		expect(mergeCloudVerdict(ALLOW_LOCAL, null)).toBe(ALLOW_LOCAL);
	});

	it("returns local unchanged when local already blocks", () => {
		const cloud: CloudVerdict = { decision: "block", reason: "cloud block too" };
		expect(mergeCloudVerdict(BLOCK_LOCAL, cloud)).toBe(BLOCK_LOCAL);
	});

	it("returns local unchanged when local is ask", () => {
		const cloud: CloudVerdict = { decision: "block", reason: "cloud block" };
		expect(mergeCloudVerdict(ASK_LOCAL, cloud)).toBe(ASK_LOCAL);
	});

	it("upgrades to block when local allows but cloud blocks", () => {
		const cloud: CloudVerdict = { decision: "block", reason: "cloud says no" };
		const merged = mergeCloudVerdict(ALLOW_LOCAL, cloud);
		expect(merged.decision).toBe("block");
		expect(merged.reason).toContain("cloud says no");
		expect(merged.reason).toContain("[cloud]");
	});

	it("unions cloud warnings into local allow with no existing warnings", () => {
		const cloud: CloudVerdict = { decision: "allow", warnings: ["cloud warn"] };
		const merged = mergeCloudVerdict(ALLOW_LOCAL, cloud);
		expect(merged.decision).toBe("allow");
		expect(merged.warnings).toEqual(["[cloud] cloud warn"]);
	});

	it("unions cloud warnings after local warnings", () => {
		const cloud: CloudVerdict = { decision: "allow", warnings: ["cloud warn"] };
		const merged = mergeCloudVerdict(ALLOW_LOCAL_WITH_WARNINGS, cloud);
		expect(merged.decision).toBe("allow");
		expect(merged.warnings).toEqual(["[interlinked] local warn", "[cloud] cloud warn"]);
	});

	it("leaves local allow unchanged when cloud allows with no warnings", () => {
		const cloud: CloudVerdict = { decision: "allow" };
		const merged = mergeCloudVerdict(ALLOW_LOCAL_WITH_WARNINGS, cloud);
		expect(merged.decision).toBe("allow");
		expect(merged.warnings).toEqual(["[interlinked] local warn"]);
	});
});

describe("isMetaTestWrapper", () => {
	it("matches `interlinked harness test <inner>`", () => {
		expect(
			isMetaTestWrapper(
				makeEvent({ tool_input: { command: 'interlinked harness test "rm -rf /"' } }),
			),
		).toBe(true);
	});

	it("matches with leading whitespace", () => {
		expect(
			isMetaTestWrapper(
				makeEvent({ tool_input: { command: '  interlinked harness test "x"' } }),
			),
		).toBe(true);
	});

	it("does NOT match `interlinked harness restart`", () => {
		expect(
			isMetaTestWrapper(makeEvent({ tool_input: { command: "interlinked harness restart" } })),
		).toBe(false);
	});

	it("does NOT match `interlinked allowlist add`", () => {
		expect(
			isMetaTestWrapper(makeEvent({ tool_input: { command: "interlinked allowlist add npm x" } })),
		).toBe(false);
	});

	it("does NOT match for non-Bash tools (even if command-shaped)", () => {
		expect(
			isMetaTestWrapper(
				makeEvent({
					tool_name: "Edit",
					tool_input: { command: "interlinked harness test x" },
				}),
			),
		).toBe(false);
	});

	it("does NOT match when command is missing or non-string", () => {
		expect(isMetaTestWrapper(makeEvent({ tool_input: {} }))).toBe(false);
		expect(isMetaTestWrapper(makeEvent({ tool_input: undefined }))).toBe(false);
	});
});
