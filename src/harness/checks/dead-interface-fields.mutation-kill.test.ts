// ===========================================================================
// Mutation-kill companion for src/harness/checks/dead-interface-fields.ts.
//
// Targets the regex-anchor and brace/colon-bookkeeping edge cases the
// existing dead-interface-fields.test.ts suite never exercises: the
// existing suite always uses well-formed, single-space, correctly-anchored
// interface/field syntax, so it never observes what happens when
// INTERFACE_OPEN_RE / FIELD_DECL_RE's `^`/`$` anchors or whitespace
// quantifiers are loosened, or when extractInterfaceFields's brace-depth
// counter goes wrong.
//
// Every fixture below was verified empirically against a real shadow
// mutation of the module (scratch/fleet-r3/dead-interface-fields-shadow-verify.mts)
// before being copied in here — each one is confirmed to diverge between
// the pristine module and its specific mutant.
//
// Receipts: scratch/fleet-r3/receipts/src_harness_checks_dead-interface-fields.ts.jsonl
// ===========================================================================

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDeadInterfaceFields } from "./dead-interface-fields.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "dead-fields-mk-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Write `files` (relPath -> content) under `tmp` and scan it as both
 *  targetDir and searchRoot, matching this module's existing test
 *  convention. Returns the flat list of dead field names found. */
function scan(files: Record<string, string>): string[] {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(tmp, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return findDeadInterfaceFields(tmp, tmp).map((f) => f.field);
}

describe("dead-interface-fields — TEST_FILE_RE anchor (mutation-kill)", () => {
	it("P1: a filename whose '.test.tsx' substring is not the true suffix is still a declaring file", () => {
		// TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/ — the trailing $ matters
		// once the substring ".test.tsx" appears mid-path rather than at the
		// very end (the file still legitimately ends in ".ts").
		const dead = scan({
			"types.test.tsx.ts": `export interface Weird {\n  ghostField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});
});

describe("dead-interface-fields — SRC_FILE_RE anchor (mutation-kill)", () => {
	it("N1: a '.tsx'-containing filename whose real extension is not .ts/.tsx is never scanned", () => {
		// SRC_FILE_RE = /\.(ts|tsx)$/ — without the trailing $ this would
		// match ANY filename containing ".tsx" as a substring, not just ones
		// ending in it.
		const dead = scan({
			"readme.tsx.bak": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N2: a non-.ts file is never treated as a source file even if it looks like one", () => {
		const dead = scan({
			"notes.txt": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});
});

describe("dead-interface-fields — INTERFACE_OPEN_RE anchors and spacing (mutation-kill)", () => {
	it("N1: a line with non-whitespace text before 'export' is not an interface open", () => {
		// The ^ anchor means "export" must be the first non-whitespace token.
		const dead = scan({
			"types.ts": `xexport interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N2: a line comment after the opening brace means the open line is NOT recognized (trailing-anchor is load-bearing)", () => {
		// The interface-open regex is anchored `\{?\s*$` — a trailing line
		// comment after the brace breaks that anchor, so this heuristic
		// scanner does not treat the line as an interface open at all (the
		// field on the next line is then never reached).
		const dead = scan({
			"types.ts": `export interface Ghost { // trailing comment\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("P2: two spaces between 'export' and 'interface' still opens the interface", () => {
		const dead = scan({
			"types.ts": `export  interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});

	it("P3: two spaces between 'interface' and the type name still opens the interface", () => {
		const dead = scan({
			"types.ts": `export interface  Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});

	it("P4: zero spaces between the type name and the opening brace still opens the interface", () => {
		const dead = scan({
			"types.ts": `export interface Ghost{\n  ghostField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});

	it("P5: a single-space extends clause still opens the interface", () => {
		const dead = scan({
			"types.ts": `export interface Ghost extends Base {\n  ghostField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});

	it("P6: an interface open line with no brace token anywhere still opens (brace assumed on a later line)", () => {
		const dead = scan({
			"types.ts": `export interface Ghost\n  ghostField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});

	it("N2: trailing non-whitespace junk right after the opening brace means the open line is NOT recognized", () => {
		const dead = scan({
			"types.ts": `export interface Ghost {x\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});
});

describe("dead-interface-fields — FIELD_DECL_RE anchor and spacing (mutation-kill)", () => {
	it("N1: a field line with non-word punctuation before the identifier is not a field declaration", () => {
		// The ^ anchor means the identifier must be the first token (mod
		// leading whitespace). A leading "-" is neither whitespace nor a
		// word character, so it must not be silently skipped over.
		const dead = scan({
			"types.ts": `export interface Ghost {\n  -ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N2: a definite-assignment '!' marker before the colon is NOT a recognized field (no '?'/'!' interplay)", () => {
		// FIELD_DECL_RE only tolerates an OPTIONAL '?' marker between the
		// identifier and the colon, not '!'. This is a pre-existing
		// heuristic gap (a real TS definite-assignment field goes unscanned)
		// but it must stay pinned rather than silently start matching.
		const dead = scan({
			"types.ts": `export interface Ghost {\n  ghostField!: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N3: stray punctuation between the identifier and the colon is NOT a recognized field", () => {
		const dead = scan({
			"types.ts": `export interface Ghost {\n  ghostField#: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("P3: zero spaces between the colon and the value still recognizes the field", () => {
		const dead = scan({
			"types.ts": `export interface Ghost {\n  ghostField:number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
	});
});

describe("dead-interface-fields — brace-depth bookkeeping (mutation-kill)", () => {
	it("N1: a nested inline-object field type does not leak its inner keys as top-level fields", () => {
		const dead = scan({
			"types.ts":
				`export interface Ghost {\n  nested: {\n    innerField: string;\n  };\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("nested");
		expect(dead).not.toContain("innerField");
		expect(dead).toContain("ghostField");
	});

	it("N2: a closed interface does not leak a following unrelated block's line as one of its fields", () => {
		// If the depth-reset on the closing "}" fails (or its body is
		// disabled), the container stays "open" and a later, unrelated
		// block's field-shaped line gets misattributed to it.
		const dead = scan({
			"types.ts": `export interface Ghost {\n  ghostField: number;\n}\n{\n  trapField: number;\n}\n`,
		});
		expect(dead).toContain("ghostField");
		expect(dead).not.toContain("trapField");
	});
});

describe("dead-interface-fields — method vs. function-typed field (mutation-kill)", () => {
	it("P1: a field whose TYPE is a function signature is a real field, not a rejected method", () => {
		// `callback: (x: number) => void;` has a paren AFTER its colon — the
		// method-rejection check must not treat that as `name(args): ret;`.
		const dead = scan({
			"types.ts": `export interface Handlers {\n  callback: (x: number) => void;\n}\n`,
			"consumer.ts": `export function f() { return 1; }\n`,
		});
		expect(dead).toContain("callback");
	});

	it("N1: the same function-typed field is correctly NOT dead when something reads it", () => {
		const dead = scan({
			"types.ts": `export interface Handlers {\n  callback: (x: number) => void;\n}\n`,
			"consumer.ts": `import type { Handlers } from "./types.js";\nexport function f(h: Handlers) { return h.callback; }\n`,
		});
		expect(dead).not.toContain("callback");
	});
});

describe("dead-interface-fields — plain no-paren field is still recognized (mutation-kill)", () => {
	it("P1: an ordinary field declaration with no parens anywhere on its line is still extracted", () => {
		const dead = scan({
			"types.ts": `export interface Settings {\n  reachable: boolean;\n  isolatedField: number;\n}\n`,
			"consumer.ts": `import { Settings } from "./types.js";\nexport function f(s: Settings) { return s.reachable; }\n`,
		});
		expect(dead).toContain("isolatedField");
		expect(dead).not.toContain("reachable");
	});
});

describe("dead-interface-fields — colocated-test declBase computation (mutation-kill)", () => {
	it("P1: a directory literally named 'foo.ts' does not break the colocated-test match for bar.ts", () => {
		// declBase strips the file's OWN trailing .ts/.tsx via a $-anchored
		// regex. Without the anchor, a non-global .replace() removes the
		// FIRST ".ts"/".tsx" substring in the whole path instead — which
		// lands inside the directory name here, not the filename.
		const dead = scan({
			"foo.ts/bar.ts": `export interface Ghost {\n  ghostField: number;\n}\n`,
			"foo.ts/bar.test.ts":
				`import type { Ghost } from "./bar.js";\nconst g: Ghost = { ghostField: 1 };\nexport {};\nvoid g.ghostField;\n`,
		});
		// The colocated test only ASSERTS the field's literal value — per
		// this detector's whole purpose, that must not count as a read.
		expect(dead).toContain("ghostField");
	});
});

describe("dead-interface-fields — declaring-file test-exclusion (mutation-kill)", () => {
	it("N1: a *.test.ts file's own interface is not itself scanned as a declaring file", () => {
		const dead = scan({
			"types.test.ts": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});
});

describe("dead-interface-fields — walkSourceFiles reserved-directory skip (mutation-kill)", () => {
	it("N1: an interface inside node_modules is never scanned", () => {
		const dead = scan({
			"node_modules/vendor.ts": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N2: an interface inside dist is never scanned", () => {
		const dead = scan({
			"dist/vendor.ts": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N3: an interface inside build is never scanned", () => {
		const dead = scan({
			"build/vendor.ts": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});

	it("N4: an interface inside a dot-directory is never scanned", () => {
		const dead = scan({
			".hidden/vendor.ts": `export interface Ghost {\n  ghostField: number;\n}\n`,
		});
		expect(dead).not.toContain("ghostField");
	});
});
