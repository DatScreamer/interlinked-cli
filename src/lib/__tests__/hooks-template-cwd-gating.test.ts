// Regression test for the CWD/dist auto-spawn gate.
//
// The generated .mjs hook used to put `<CWD>/dist/harness/server.js` first
// in its candidate list, so any user repo that happened to have a build
// artifact at that path would have its own unrelated file spawned as the
// Interlinked daemon on SessionStart — letting arbitrary project-local code
// execute and bypassing the installed CLI entirely. The fix gates that
// candidate behind a package.json-name check so only the actual
// interlinked-cli source checkout opts in.
//
// We can't easily run the emitted .mjs in isolation, so this test asserts
// the GUARD against the source template: the candidate construction MUST be
// inside an `isInterlinkedCliCheckout(CWD)` branch — never unconditional.

import { describe, expect, it } from "vitest";
import { buildHookScript } from "../hooks-template.js";

const SCRIPT = buildHookScript("test-version");

describe("hooks-template: CWD/dist auto-spawn gating (Plan 08 review)", () => {
	it("emits the isInterlinkedCliCheckout predicate", () => {
		expect(SCRIPT).toContain("function isInterlinkedCliCheckout(cwd)");
		expect(SCRIPT).toContain('pkg.name === "interlinked-cli"');
	});

	it("emits exactly one CWD/dist push, inside tryAutoStartHarness", () => {
		const cwdCandidatePattern = /candidates\.push\(join\(CWD, "dist", "harness", "server\.js"\)\)/g;
		const matches = SCRIPT.match(cwdCandidatePattern);
		// Failing this assertion means either the push was deleted (count 0)
		// or duplicated (count >1) — both indicate a refactor regression.
		expect(matches?.length).toBe(1);
	});

	it("places the isInterlinkedCliCheckout gate before the CWD/dist push", () => {
		// The CWD-rooted candidate must only be pushed inside the gate.
		// Compute positions; assert ordering. Both indices must be -1-positive
		// (substring is present) and gate must come before push.
		const gateIdx = SCRIPT.indexOf("if (isInterlinkedCliCheckout(CWD))");
		const pushIdx = SCRIPT.indexOf('candidates.push(join(CWD, "dist", "harness", "server.js"))');
		expect(gateIdx).toBeGreaterThan(0);
		expect(pushIdx).toBeGreaterThan(gateIdx);
	});

	it("does not include the CWD/dist path as the very first array literal", () => {
		// The earlier shape was `const candidates = [join(CWD, "dist", ...]`.
		// Verify that exact shape is gone — the only allowed occurrence of
		// the CWD/dist path is the gated `candidates.push(...)` form.
		const arrayLiteralWithCwdFirst =
			/const candidates = \[\s*\n?\s*join\(CWD, "dist"/;
		expect(arrayLiteralWithCwdFirst.test(SCRIPT)).toBe(false);
	});

	it("fail-closed: predicate body returns false on missing/malformed package.json", () => {
		// The implementation reads CWD/package.json and returns false on any
		// throw or absence. Verify the source body has both branches.
		expect(SCRIPT).toContain("if (!existsSync(pkgPath)) return false;");
		expect(SCRIPT).toMatch(/catch \(_err\) \{[^}]*return false/);
	});
});
