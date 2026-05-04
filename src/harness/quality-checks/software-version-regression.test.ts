import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QualityCheckConfig } from "../types.js";
import { formatQualityWarnings, runQualityChecks } from "../quality-checks.js";
import {
	collectSoftwareVersionReferences,
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
} from "./software-version-regression.js";

const SOFTWARE_VERSION_CHECKS: Record<string, QualityCheckConfig> = {
	software_version_regression: {
		enabled: true,
		file_types: ["package.json", ".ts", ".yaml", "Dockerfile"],
		timeout_ms: 1_000,
		severity: "error",
	},
	freshness_sensitive_reference: {
		enabled: true,
		file_types: ["package.json", ".ts", ".yaml", "Dockerfile"],
		timeout_ms: 1_000,
		severity: "warning",
	},
};

describe("software version regression detector", () => {
	it("detects package dependency downgrades in package.json", () => {
		const before = collectSoftwareVersionReferences(
			JSON.stringify({ dependencies: { react: "^19.0.0" } }, null, 2),
			"package.json",
		);
		const after = collectSoftwareVersionReferences(
			JSON.stringify({ dependencies: { react: "^18.2.0" } }, null, 2),
			"package.json",
		);

		const regressions = detectSoftwareVersionRegressions(before, after);

		expect(regressions).toHaveLength(1);
		expect(regressions[0].after.label).toBe("dependencies react");
		expect(regressions[0].before.version).toBe("^19.0.0");
		expect(regressions[0].after.version).toBe("^18.2.0");
	});

	it("detects model-name downgrades in code assignments", () => {
		const before = collectSoftwareVersionReferences(
			'export const model = "vendor-model-v6";\n',
			"src/models.ts",
		);
		const after = collectSoftwareVersionReferences(
			'export const model = "vendor-model-v4";\n',
			"src/models.ts",
		);

		const regressions = detectSoftwareVersionRegressions(before, after);

		expect(regressions).toHaveLength(1);
		expect(regressions[0].after.label).toBe("model");
		expect(regressions[0].before.version).toBe("vendor-model-v6");
		expect(regressions[0].after.version).toBe("vendor-model-v4");
	});

	it("detects GitHub Action and Docker tag downgrades", () => {
		const before = collectSoftwareVersionReferences(
			["uses: actions/setup-node@v6", "FROM node:22-alpine"].join("\n"),
			".github/workflows/ci.yml",
		);
		const after = collectSoftwareVersionReferences(
			["uses: actions/setup-node@v4", "FROM node:20-alpine"].join("\n"),
			".github/workflows/ci.yml",
		);

		const labels = detectSoftwareVersionRegressions(before, after).map((r) => r.after.label);

		expect(labels).toEqual(["GitHub Action actions/setup-node", "Docker image node"]);
	});

	it("does not flag upgrades or model provider changes", () => {
		const before = collectSoftwareVersionReferences(
			['export const model = "vendor-model-v4";', 'export const sdkVersion = "4.1.0";'].join("\n"),
			"src/config.ts",
		);
		const after = collectSoftwareVersionReferences(
			['export const model = "other-model-v4";', 'export const sdkVersion = "5.0.0";'].join("\n"),
			"src/config.ts",
		);

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("does not flag unchanged nested versions in a package-lock.json", () => {
		const lockfile = JSON.stringify(
			{
				name: "demo",
				version: "2.0.0",
				lockfileVersion: 3,
				packages: {
					"node_modules/lodash": { version: "1.0.0" },
					"node_modules/zod": { version: "3.22.0" },
				},
			},
			null,
			2,
		);

		const before = collectSoftwareVersionReferences(lockfile, "package-lock.json");
		const after = collectSoftwareVersionReferences(lockfile, "package-lock.json");

		expect(detectSoftwareVersionRegressions(before, after)).toEqual([]);
	});

	it("flags a real downgrade of a nested package-lock.json dependency", () => {
		const beforeContent = JSON.stringify(
			{
				name: "demo",
				version: "2.0.0",
				lockfileVersion: 3,
				packages: {
					"node_modules/lodash": { version: "2.0.0" },
				},
			},
			null,
			2,
		);
		const afterContent = JSON.stringify(
			{
				name: "demo",
				version: "2.0.0",
				lockfileVersion: 3,
				packages: {
					"node_modules/lodash": { version: "1.0.0" },
				},
			},
			null,
			2,
		);

		const before = collectSoftwareVersionReferences(beforeContent, "package-lock.json");
		const after = collectSoftwareVersionReferences(afterContent, "package-lock.json");

		const regressions = detectSoftwareVersionRegressions(before, after);
		const lodashDowngrade = regressions.find(
			(r) => r.before.version === "2.0.0" && r.after.version === "1.0.0",
		);
		expect(lodashDowngrade).toBeDefined();
	});

	it("flags newly introduced freshness-sensitive model refs without claiming they are deprecated", () => {
		const before = collectSoftwareVersionReferences("export const x = 1;\n", "src/config.ts");
		const after = collectSoftwareVersionReferences(
			'export const model = "vendor-model-v4";\n',
			"src/config.ts",
		);

		const concerns = detectSoftwareVersionFreshnessConcerns(before, after);

		expect(concerns).toHaveLength(1);
		expect(concerns[0].ref.version).toBe("vendor-model-v4");
		expect(concerns[0].reason).toContain("verify against provider docs");
		expect(concerns[0].verifyHint.source).toContain("official model provider documentation");
		expect(concerns[0].reason).not.toContain("deprecated");
	});
});

describe("runQualityChecks software_version_regression", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-version-regression-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports a PostToolUse quality result with knowledge-cutoff remediation", async () => {
		const filePath = join(dir, "package.json");
		const beforeContent = JSON.stringify({ dependencies: { "@ai/sdk": "^6.0.0" } }, null, 2);
		const afterContent = JSON.stringify({ dependencies: { "@ai/sdk": "^4.0.0" } }, null, 2);
		writeFileSync(filePath, afterContent);

		const results = await runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "s",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-04T00:00:00.000Z",
			},
			SOFTWARE_VERSION_CHECKS,
			dir,
			{
				baseline: {
					missingReturnTypes: new Set(),
					complexFunctions: new Set(),
					capturedAt: 1_777_852_800_000,
					suppressionCount: 0,
					asAnyCastCount: 0,
					nonNullAssertionCount: 0,
					softwareVersions: collectSoftwareVersionReferences(beforeContent, filePath),
				},
			},
		);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			name: "software_version_regression",
			severity: "error",
			file: filePath,
		});
		expect(results[0].detail).toContain("@ai/sdk ^6.0.0 -> ^4.0.0");

		const [warning] = formatQualityWarnings(results);
		expect(warning).toContain("[interlinked:software_version_regression] [heuristic]");
		expect(warning).toContain("knowledge cutoff date");
		expect(warning).toContain("search/fetch official docs");
		expect(warning).toContain("PostToolUse attention required");
	});

	it("reports a freshness-sensitive new model reference without hardcoding current models", async () => {
		const filePath = join(dir, "config.ts");
		writeFileSync(filePath, 'export const model = "vendor-model-v4";\n');

		const results = await runQualityChecks(
			{
				hook_event: "PostToolUse",
				session_id: "s",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: filePath },
				timestamp: "2026-05-04T00:00:00.000Z",
			},
			SOFTWARE_VERSION_CHECKS,
			dir,
		);

		expect(results.find((r) => r.name === "software_version_regression")).toBeUndefined();
		const freshnessResult = results.find((r) => r.name === "freshness_sensitive_reference");
		expect(freshnessResult).toBeDefined();
		expect(freshnessResult?.message).toContain("freshness-sensitive software reference");
		expect(freshnessResult?.detail).toContain("vendor-model-v4");
		expect(freshnessResult?.detail).toContain("official model provider documentation");

		const warning = formatQualityWarnings(results).join("\n");
		expect(warning).toContain("[interlinked:freshness_sensitive_reference] [heuristic]");
		expect(warning).toContain("Verify the newly introduced reference against official current sources");
	});
});
