import { describe, expect, it } from "vitest";
import type { CloudVerdict } from "../../lib/cloud-governor.js";
import { mergeCloudVerdict } from "../cloud-forward.js";
import type { HarnessDecision } from "../types.js";

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
