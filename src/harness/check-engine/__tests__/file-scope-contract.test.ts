// ===========================================
// Tool-runner file-scope contract (round 7, finding 2026-06)
// ===========================================
// A per-edit check runs tools in FILE mode and must surface only the EDITED
// file's findings. rustfmt pointed at a crate root followed `mod` declarations
// and reported child-module diffs, ignoring scope.filterToFile — pre-existing
// formatting elsewhere blocked an unrelated edit (finding 2026-06, round 7).
//
// This is the generalizable tripwire: ANY runner that branches on file mode
// must DO something with the target — either pass the single `targetFile` to a
// tool that only reports that file, or `filterResultsToFile` / honor
// `scope.filterToFile` after parsing. A runner that branches on `mode ===
// "file"` yet never names the target is reporting project-wide findings under
// a file-scoped contract. Source-level (like docs-freshness / pipeline-parity
// meta-tests): it catches a NEW runner that forgets scope; behavioral
// correctness of the scoping itself is pinned per-runner (e.g. rust.test.ts).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNERS_DIR = fileURLToPath(new URL("../tool-runners", import.meta.url));

/** Runners exempt from the target-reference rule, each with a reason. Empty —
 *  every current file-mode runner scopes to the target; the list may only
 *  grow with an explicit, reviewed justification. */
const EXEMPT: Record<string, string> = {};

const FILE_MODE_RE = /===\s*["']file["']/;
const SCOPES_TO_TARGET_RE = /filterResultsToFile|filterToFile|targetFile/;

describe("tool-runner file-scope contract", () => {
	const files = readdirSync(RUNNERS_DIR).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
	);

	it("found the runner sources (the scan works)", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it("every file-mode runner scopes its findings to the edited file", () => {
		const offenders: string[] = [];
		for (const f of files) {
			if (EXEMPT[f]) continue;
			const src = readFileSync(`${RUNNERS_DIR}/${f}`, "utf-8");
			if (FILE_MODE_RE.test(src) && !SCOPES_TO_TARGET_RE.test(src)) {
				offenders.push(f);
			}
		}
		expect(
			offenders,
			"these runners branch on file mode but never reference the target file — file-scoped findings will leak project-wide diffs (see rust.ts round 7)",
		).toEqual([]);
	});

	it("the exemption list only holds runners that still exist", () => {
		const stale = Object.keys(EXEMPT).filter((f) => !files.includes(f));
		expect(stale, "remove exemptions for deleted runners").toEqual([]);
	});
});
