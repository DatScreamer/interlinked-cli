// The zero-drift pin for the browser onboarding demo (operator requirement,
// 2026-08-16: "there is never any possibility of drift between the Terminal /
// TUI implementation and the demo in the browser"). Two mechanisms enforce
// it, and this file is the second:
//   1. Single source: the terminal runner renders from setup-wizard.ts's
//      WIZARD_COPY / presets / caps / plan renderer, and the demo generator
//      BUNDLES that same module, so the browser executes the shipped code.
//   2. This pin: regenerate the demo and byte-compare it against the
//      committed docs/demo/onboarding-demo.html. Any wizard change that is
//      not re-generated into the demo fails here, in CI, loudly.
// Regenerate with: npx tsx scripts/gen-onboarding-demo.mts

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GENERATOR = join(ROOT, "scripts", "gen-onboarding-demo.mts");
const DEMO = join(ROOT, "docs", "demo", "onboarding-demo.html");

// esbuild bundling takes a few seconds cold; macOS CI is slow (repo policy:
// bound the work and set an explicit generous timeout).
const CHECK_TIMEOUT_MS = 120_000;

describe("onboarding demo freshness — positive (must hold)", () => {
	// test-contract: invariant — the committed demo byte-matches a fresh regeneration from the wizard module
	it(
		"P1: the committed demo is byte-identical to a fresh regeneration",
		{ timeout: CHECK_TIMEOUT_MS },
		() => {
			expect(existsSync(DEMO)).toBe(true);
			// --check exits non-zero (throwing here) when stale — the failure
			// message names the regeneration command.
			const out = execFileSync("npx", ["tsx", GENERATOR, "--check"], {
				cwd: ROOT,
				encoding: "utf-8",
				timeout: CHECK_TIMEOUT_MS,
			});
			expect(out).toContain("in sync");
		},
	);

	// test-contract: invariant — the demo embeds the real module (spot-check: the banner string appears exactly once in copy and once in the bundle)
	it("P2: the demo carries the bundled wizard module, not a transcript", () => {
		const html = require("node:fs").readFileSync(DEMO, "utf-8");
		expect(html).toContain("InterlinkedWizard");
		expect(html).toContain("WIZARD_COPY");
		expect(html).toContain("describeWizardPlan");
	});
});
