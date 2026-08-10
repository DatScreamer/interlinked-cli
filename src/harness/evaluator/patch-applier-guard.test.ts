// Tests for the hand-rolled patch-applier detector. The positive cases are
// modelled on the real artifact this guard exists for: the `plm/apply.mjs`
// anchor/replacement applier recovered from the 2026-07 scratchpad archive.

import { afterEach, describe, expect, it } from "vitest";
import {
	buildPatchApplierReason,
	detectPatchApplier,
	isPatchApplierGuardDisabled,
} from "./patch-applier-guard.js";

describe("detectPatchApplier — positive (must fire)", () => {
	it("P1: anchor/replacement applier writing into src/", () => {
		const content = [
			'import { readFileSync, writeFileSync } from "node:fs";',
			'const anchor = readFileSync("r1.anchor.txt", "utf-8");',
			'const next = readFileSync("r1.new.txt", "utf-8");',
			'const target = "src/harness/obligations.ts";',
			"const src = readFileSync(target, 'utf-8');",
			"writeFileSync(target, src.replace(anchor, next));",
		].join("\n");
		const hit = detectPatchApplier(content, "/tmp/s/scratchpad/plm/apply.mjs");
		expect(hit).not.toBeNull();
		expect(hit?.writeCall).toContain("writeFileSync");
	});

	it("P2: inlined payload (no read) still fires — reading is not required", () => {
		const content = 'writeFileSync("src/lib/config.ts", "export const X = 1;\\n");';
		expect(detectPatchApplier(content, "/tmp/s/scratchpad/gen.mjs")).not.toBeNull();
	});

	it("P3: computed target via process.cwd()", () => {
		const content = [
			'const fs = require("fs");',
			'const p = require("path").join(process.cwd(), "lib", "x.ts");',
			'fs.writeFileSync(p, "…");',
		].join("\n");
		expect(detectPatchApplier(content, "/tmp/s/scratchpad/apply.cjs")).not.toBeNull();
	});

	it("P4: python applier using write_text on a repo path", () => {
		const content = ['from pathlib import Path', 'Path("src/a.py").write_text(payload)'].join(
			"\n",
		);
		expect(detectPatchApplier(content, "/tmp/s/scratchpad/fix_assembly.py")).not.toBeNull();
	});

	it("P5: parent-escape relative target", () => {
		const content = 'appendFileSync("../src/harness/notes.ts", chunk);';
		expect(detectPatchApplier(content, "/repo/scratch/probe.mjs")).not.toBeNull();
	});
});

describe("detectPatchApplier — negative (must not fire)", () => {
	it("N1: probe that only reads repo source", () => {
		const content = [
			'import { readFileSync } from "node:fs";',
			'const s = readFileSync("src/harness/large-file-policy.ts", "utf-8");',
			"console.log(s.length);",
		].join("\n");
		expect(detectPatchApplier(content, "/tmp/s/scratchpad/probe.mjs")).toBeNull();
	});

	it("N2: script writing only inside its own sandbox", () => {
		const content = 'writeFileSync("out.json", JSON.stringify(rows));';
		expect(detectPatchApplier(content, "/tmp/s/scratchpad/collect.mjs")).toBeNull();
	});

	it("N3: non-script extension is not a channel", () => {
		const content = 'writeFileSync("src/a.ts", "x");';
		expect(detectPatchApplier(content, "/tmp/s/scratchpad/notes.md")).toBeNull();
	});

	it("N4: prose mentioning a repo path with no write call", () => {
		const content = 'const doc = "see src/harness/server.ts for the socket";';
		expect(detectPatchApplier(content, "/repo/scratch/notes.ts")).toBeNull();
	});

	it("N5: empty content", () => {
		expect(detectPatchApplier("", "/tmp/s/scratchpad/apply.mjs")).toBeNull();
	});
});

describe("buildPatchApplierReason", () => {
	it("names both matched fragments and the sanctioned channel", () => {
		const reason = buildPatchApplierReason({
			target: "/tmp/s/scratchpad/plm/apply.mjs",
			evidence: { writeCall: "writeFileSync(", repoTarget: '"src/a.ts"' },
		});
		expect(reason).toContain("apply.mjs");
		expect(reason).toContain("writeFileSync(");
		expect(reason).toContain('"src/a.ts"');
		expect(reason).toContain("transient debt");
	});
});

describe("isPatchApplierGuardDisabled", () => {
	afterEach(() => {
		delete process.env.INTERLINKED_DISABLE_PATCH_APPLIER_GUARD;
	});

	it("is off by default and on only for the exact opt-out value", () => {
		expect(isPatchApplierGuardDisabled()).toBe(false);
		process.env.INTERLINKED_DISABLE_PATCH_APPLIER_GUARD = "true";
		expect(isPatchApplierGuardDisabled()).toBe(false);
		process.env.INTERLINKED_DISABLE_PATCH_APPLIER_GUARD = "1";
		expect(isPatchApplierGuardDisabled()).toBe(true);
	});
});

// Red-team F3 (docs/design/red-team-findings-2026-08-09.md): the guard blocked
// a probe script that WRITES NOTHING — it only carried write-shaped strings as
// socket payloads. Both required signals were matched lexically, so a string
// literal counted as a call. Any review tool, security fixture, or analysis
// script that QUOTES offending code trips the same wire.
describe("detectPatchApplier — write-shaped DATA is not a write — negative (must NOT fire)", () => {
	it("N1: a write call quoted inside a double-quoted string is data", () => {
		const src = [
			"const payload = \"python3 -c \\\"open('src/x.ts','w').write('h')\\\"\";",
			"send(payload);",
		].join("\n");
		expect(detectPatchApplier(src, "probe.mjs")).toBeNull();
	});

	it("N2: a write call quoted inside a single-quoted string is data", () => {
		const src = ["const cmd = 'writeFileSync(\"src/x.ts\", body)';", "record(cmd);"].join("\n");
		expect(detectPatchApplier(src, "probe.mjs")).toBeNull();
	});

	it("N3: a write call named only in a comment is data", () => {
		const src = ["// writeFileSync('src/x.ts', body) is what an applier does", "run();"].join("\n");
		expect(detectPatchApplier(src, "probe.mjs")).toBeNull();
	});
});

describe("detectPatchApplier — real appliers still caught — positive (must fire)", () => {
	it("P1: a genuine writeFileSync into repo source still fires", () => {
		const src = ['writeFileSync("src/harness/x.ts", patched);'].join("\n");
		expect(detectPatchApplier(src, "apply.mjs")).not.toBeNull();
	});

	it("P2: a genuine call whose PATH is a string literal still fires", () => {
		const src = ["const dest = 'src/harness/y.ts';", "writeFileSync(dest, patched);"].join("\n");
		expect(detectPatchApplier(src, "apply.mjs")).not.toBeNull();
	});
});
