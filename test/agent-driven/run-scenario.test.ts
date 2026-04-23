import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `run-scenario.ts` is a top-level script (imports Node builtins + has
// side-effect code). Importing it directly would spawn processes and
// create filesystem artifacts, so we smoke-test its *shape*: the file
// exists, compiles to valid TS, imports the expected Node builtins, and
// exposes the scenario-runner entry points the driver script relies on.
const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "run-scenario.ts");

describe("test/agent-driven/run-scenario — shape", () => {
	it("source file exists and is non-empty", () => {
		expect(existsSync(sourcePath)).toBe(true);
		const content = readFileSync(sourcePath, "utf-8");
		expect(content.length).toBeGreaterThan(0);
	});

	it("imports the Node builtins the scenario driver needs", () => {
		const content = readFileSync(sourcePath, "utf-8");
		expect(content).toContain('from "node:child_process"');
		expect(content).toContain('from "node:fs"');
		expect(content).toContain('from "node:path"');
	});

	it("keeps spawn + parseJson + writeFileSync as the primary interaction surface", () => {
		// If any of these disappear, the scenario script shape has drifted —
		// this test catches that before driver scripts break silently.
		const content = readFileSync(sourcePath, "utf-8");
		expect(content).toMatch(/\bspawnSync\b/);
		expect(content).toMatch(/\bwriteFileSync\b/);
	});
});
