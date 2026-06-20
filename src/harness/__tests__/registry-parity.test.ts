// Tests for the configurable registry-parity detector.
//
// The detector reads `.interlinked/registry-parity.json` and reports
// drift between paired registries declared there. Generic mechanism;
// each project's pairs come from its own config. These tests use
// per-test tmpdirs with synthetic source files + config, so they
// exercise the detector's behavior independently of this repo's
// actual registries.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	checkRegistryParity,
	extractKeys,
	loadRegistryParityConfig,
	REGISTRY_PARITY_CONFIG_PATH,
	type RegistryParityConfig,
	runRegistryParityCheck,
} from "../registry-parity.js";
import { nonNull } from "../../lib/non-null.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "registry-parity-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
	const full = join(dir, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

function writeConfig(config: unknown): void {
	writeFile(REGISTRY_PARITY_CONFIG_PATH, JSON.stringify(config));
}

describe("extractKeys", () => {
	it("returns the set of capture-1 matches", () => {
		const out = extractKeys('check: "alpha"\ncheck: "beta"\ncheck: "alpha"', 'check:\\s*"([a-z]+)"');
		expect(out).toEqual(new Set(["alpha", "beta"]));
	});

	it("returns empty set when no matches", () => {
		expect(extractKeys("nothing here", 'check:\\s*"([a-z]+)"')).toEqual(new Set());
	});

	it("ignores capture-1 undefined matches", () => {
		// Pattern with two alternatives; one branch has no capture group filled.
		const out = extractKeys('id: "x"; id: "y"', 'id:\\s*"([a-z]+)"');
		expect(out).toEqual(new Set(["x", "y"]));
	});
});

describe("loadRegistryParityConfig", () => {
	it("returns null when no config file exists", () => {
		expect(loadRegistryParityConfig(dir)).toBeNull();
	});

	it("loads and validates a minimal config", () => {
		writeConfig({
			pairs: [
				{
					name: "p1",
					left: { file: "a.ts", key_re: 'check:\\s*"([a-z]+)"' },
					right: { file: "b.ts", key_re: 'check:\\s*"([a-z]+)"' },
				},
			],
		});
		const c = loadRegistryParityConfig(dir);
		expect(c?.pairs).toHaveLength(1);
		expect(nonNull(c?.pairs[0]).name).toBe("p1");
		expect(nonNull(c?.pairs[0]).left.file).toBe("a.ts");
	});

	it("loads optional allowlists", () => {
		writeConfig({
			pairs: [
				{
					name: "p1",
					left: { file: "a.ts", key_re: 'x:"([a-z]+)"' },
					right: { file: "b.ts", key_re: 'x:"([a-z]+)"' },
					left_only_allowed: ["alpha"],
					right_only_allowed: ["beta"],
				},
			],
		});
		const c = loadRegistryParityConfig(dir);
		expect(nonNull(c?.pairs[0]).left_only_allowed).toEqual(["alpha"]);
		expect(nonNull(c?.pairs[0]).right_only_allowed).toEqual(["beta"]);
	});

	it("rejects malformed configs loudly", () => {
		writeFile(REGISTRY_PARITY_CONFIG_PATH, "not json");
		expect(() => loadRegistryParityConfig(dir)).toThrow();

		writeConfig({ pairs: "wrong-shape" });
		expect(() => loadRegistryParityConfig(dir)).toThrow();

		writeConfig({ pairs: [{ name: 1 }] });
		expect(() => loadRegistryParityConfig(dir)).toThrow();
	});
});

describe("checkRegistryParity", () => {
	function pairConfig(extras: Partial<RegistryParityConfig["pairs"][number]> = {}): RegistryParityConfig {
		return {
			pairs: [
				{
					name: "test-pair",
					left: { file: "left.ts", key_re: 'check:\\s*"([a-z]+)"' },
					right: { file: "right.ts", key_re: 'check:\\s*"([a-z]+)"' },
					...extras,
				},
			],
		};
	}

	it("reports nothing when both files have identical IDs", () => {
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"\ncheck: "beta"');
		const findings = checkRegistryParity(pairConfig(), dir);
		expect(findings).toEqual([]);
	});

	it("reports drift when left has an ID that right lacks", () => {
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		const findings = checkRegistryParity(pairConfig(), dir);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).kind).toBe("missing-from-right");
		expect(nonNull(findings[0]).id).toBe("beta");
		expect(nonNull(findings[0]).source_file).toBe("left.ts");
		expect(nonNull(findings[0]).target_file).toBe("right.ts");
	});

	it("reports drift when right has an ID that left lacks", () => {
		writeFile("left.ts", 'check: "alpha"');
		writeFile("right.ts", 'check: "alpha"\ncheck: "gamma"');
		const findings = checkRegistryParity(pairConfig(), dir);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).kind).toBe("missing-from-left");
		expect(nonNull(findings[0]).id).toBe("gamma");
	});

	it("respects left_only_allowed", () => {
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		const findings = checkRegistryParity(
			pairConfig({ left_only_allowed: ["beta"] }),
			dir,
		);
		expect(findings).toEqual([]);
	});

	it("respects right_only_allowed", () => {
		writeFile("left.ts", 'check: "alpha"');
		writeFile("right.ts", 'check: "alpha"\ncheck: "gamma"');
		const findings = checkRegistryParity(
			pairConfig({ right_only_allowed: ["gamma"] }),
			dir,
		);
		expect(findings).toEqual([]);
	});

	it("reports both directions when both sides drift", () => {
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"\ncheck: "gamma"');
		const findings = checkRegistryParity(pairConfig(), dir);
		expect(findings).toHaveLength(2);
		const kinds = findings.map((f) => f.kind).sort();
		expect(kinds).toEqual(["missing-from-left", "missing-from-right"]);
	});

	it("reports missing-file when a configured file does not exist", () => {
		writeFile("left.ts", 'check: "alpha"');
		// right.ts deliberately not created
		const findings = checkRegistryParity(pairConfig(), dir);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).kind).toBe("missing-file");
	});

	it("handles multiple pairs independently", () => {
		writeFile("a.ts", 'check: "alpha"');
		writeFile("b.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("c.ts", 'check: "x"\ncheck: "y"');
		writeFile("d.ts", 'check: "x"\ncheck: "y"');
		const cfg: RegistryParityConfig = {
			pairs: [
				{
					name: "p1",
					left: { file: "a.ts", key_re: 'check:\\s*"([a-z]+)"' },
					right: { file: "b.ts", key_re: 'check:\\s*"([a-z]+)"' },
				},
				{
					name: "p2",
					left: { file: "c.ts", key_re: 'check:\\s*"([a-z]+)"' },
					right: { file: "d.ts", key_re: 'check:\\s*"([a-z]+)"' },
				},
			],
		};
		const findings = checkRegistryParity(cfg, dir);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).pair).toBe("p1");
		expect(nonNull(findings[0]).id).toBe("beta");
	});
});

describe("runRegistryParityCheck (load + run)", () => {
	it("returns empty array when no config is present (no-op for non-opted-in projects)", () => {
		expect(runRegistryParityCheck(dir)).toEqual([]);
	});

	it("loads and runs in one shot when config + files are present", () => {
		writeFile("left.ts", 'check: "alpha"\ncheck: "beta"');
		writeFile("right.ts", 'check: "alpha"');
		writeConfig({
			pairs: [
				{
					name: "drift-pair",
					left: { file: "left.ts", key_re: 'check:\\s*"([a-z]+)"' },
					right: { file: "right.ts", key_re: 'check:\\s*"([a-z]+)"' },
				},
			],
		});
		const findings = runRegistryParityCheck(dir);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).id).toBe("beta");
	});
});
