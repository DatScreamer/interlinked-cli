import { describe, expect, it } from "vitest";
import { downBranchBash, resolveReviveBakes } from "./statusline-revive.js";

/**
 * The statusline's daemon-down branch: grace debounce → throttled auto-revive
 * → calm reviving row → alarm only past the threshold. Pure string builder so
 * the bash fragment is testable without generating the whole script.
 */
const BAKES = { nodeBin: "/opt/node/bin/node", serverJs: "/repo/dist/harness/server.js", heapMb: 1536 };

describe("downBranchBash — positive (must revive)", () => {
	it("P1: bakes node, server, heap and expose-gc into the spawn line", () => {
		const b = downBranchBash(BAKES);
		expect(b).toContain('REVIVE_NODE="/opt/node/bin/node"');
		expect(b).toContain('REVIVE_SERVER="/repo/dist/harness/server.js"');
		expect(b).toContain("--max-old-space-size=1536");
		expect(b).toContain("--expose-gc");
	});

	it("P2: throttles via marker file at 20s and alarms only past 45s down", () => {
		const b = downBranchBash(BAKES);
		expect(b).toContain('REVIVE_MARK="$ID/.statusline-revive-at"');
		expect(b).toContain("REVIVE_THROTTLE_SECS=20");
		expect(b).toContain("REVIVE_ALARM_SECS=45");
	});

	it("P3: spawn is detached, silenced, and targets the walked-to root", () => {
		const spawnLine = downBranchBash(BAKES)
			.split("\n")
			.find((l) => l.includes('"$REVIVE_SERVER" --cwd'));
		expect(spawnLine).toBeDefined();
		expect(spawnLine).toContain('--cwd "$ROOT"');
		expect(spawnLine).toContain(">/dev/null 2>&1 &");
	});

	it("P4: keeps the calm reviving row and the escalated offline alarm", () => {
		const b = downBranchBash(BAKES);
		expect(b).toContain("auto-reviving");
		expect(b).toContain("harness offline");
	});
});

describe("downBranchBash — negative (must degrade safely)", () => {
	it("N1: an empty server bake keeps the guard so the spawn no-ops", () => {
		const b = downBranchBash({ ...BAKES, serverJs: "" });
		expect(b).toContain('REVIVE_SERVER=""');
		expect(b).toContain('-n "$REVIVE_SERVER"');
	});

	it("N2: resolveReviveBakes never throws and always yields this process's node", () => {
		const bakes = resolveReviveBakes();
		expect(bakes.nodeBin).toBe(process.execPath);
		expect(bakes.heapMb).toBeGreaterThan(0);
	});
});
