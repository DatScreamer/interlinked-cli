// Regression pin for the "set n=1" failure class (mcp-client-bio, 2026-07): a
// BUILT hook artifact advertised its one-off bypass with a minified identifier
// instead of the literal env-var name, making the escape hatch undiscoverable
// exactly when a blocked agent needed it. Source-level string literals survive
// minification, so this scans the BUILT bundles: any advertised `set X=1`
// bypass must name a literal INTERLINKED_* env var. Skips when dist/ hasn't
// been built (fresh checkout) — the artifact, not the source, is under test.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIST_BUNDLES = ["hook-entry.js", "index.js", "harness/server.js"].map((f) =>
	join(import.meta.dirname, "..", "..", "..", "dist", f),
);

const built = DIST_BUNDLES.filter((p) => existsSync(p));

describe.skipIf(built.length === 0)("built bundles — bypass advertisements are literal", () => {
	it("every advertised `... set X=1` bypass names INTERLINKED_<FLAG>, not a mangled identifier", () => {
		for (const bundle of built) {
			const text = readFileSync(bundle, "utf-8");
			// The advertisement grammar every gate message uses: "…, set <VAR>=1".
			for (const m of text.matchAll(/\bset ([A-Za-z_$][\w$]*)=1\b/g)) {
				expect(m[1], `${bundle} advertises "set ${m[1]}=1"`).toMatch(/^INTERLINKED_[A-Z_]+$/);
			}
		}
	});
});
