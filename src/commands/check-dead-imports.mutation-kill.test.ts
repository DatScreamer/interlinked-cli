import { describe, expect, it } from "vitest";

import { extractBindings, findDeadImports } from "./check-dead-imports.js";

// Pass-1 completion sweep (fleet-r3/W6, LEAN MODE). Targets the survivor residue
// left after src/commands/check-dead-imports.test.ts's 25 committed tests. Each
// case below was traced by hand against the pristine module and confirmed via a
// throwaway scratch probe before being written here — see the wave receipts in
// scratch/fleet-r3/receipts/check-dead-imports.jsonl for the full mutant-by-mutant
// disposition (killed / equivalent / already covered by the pre-existing suite).

describe("extractBindings — anchored guard/regex boundary mutants", () => {
	// test-contract: invariant — the "//" guard is startsWith, not endsWith, so a trailing marker must not suppress it
	it("does not treat a trailing '//' at the end of the line as a leading comment marker", () => {
		const bindings: string[] = [];
		extractBindings("import { Foo } from './source'//", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: invariant — the bare-specifier quote guard is anchored to line start, not substring-anywhere
	it("does not let a quote-guard pattern buried in the module specifier suppress a real named import", () => {
		const bindings: string[] = [];
		extractBindings(`import { Foo } from 'text import "y"'`, bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: invariant — the namespace-import guard is anchored to line start, not substring-anywhere
	it("does not let a namespace-guard pattern buried in the module specifier suppress a real named import", () => {
		const bindings: string[] = [];
		extractBindings("import { Foo } from 'text import * as y'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: invariant — the named-import regex is anchored, so "reimport {" must not match "import {"
	it("does not extract a named import from a line that only contains, but does not start with, 'import {'", () => {
		const bindings: string[] = [];
		extractBindings("reimport { Foo } from './x'", bindings);
		expect(bindings).toEqual([]);
	});

	// test-contract: boundary — the import-to-brace gap is \s+ (one or more), not a fixed single space
	it("accepts multiple spaces between import and the opening brace", () => {
		const bindings: string[] = [];
		extractBindings("import  { Foo } from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: boundary — the type-keyword-to-brace gap is \s+ (one or more), not a fixed single space
	it("accepts multiple spaces between the type keyword and the opening brace", () => {
		const bindings: string[] = [];
		extractBindings("import type  { Foo } from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: bug — a stray leading comma's empty split entry must be dropped, not pushed as a binding
	it("drops an empty entry produced by a stray leading comma instead of pushing it as a binding", () => {
		const bindings: string[] = [];
		extractBindings("import { , Foo } from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: invariant — the default-import regex is anchored, so "reimport Foo" must not match "import Foo"
	it("does not extract a default import from a line that only contains, but does not start with, 'import'", () => {
		const bindings: string[] = [];
		extractBindings("reimport Foo from './x'", bindings);
		expect(bindings).toEqual([]);
	});

	// test-contract: boundary — the import-to-default-name gap is \s+ (one or more), not a fixed single space
	it("accepts multiple spaces between import and a default binding name", () => {
		const bindings: string[] = [];
		extractBindings("import  Foo from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: boundary — the type-keyword-to-default-name gap is \s+ (one or more), not a single space
	it("accepts multiple spaces between the type keyword and a default binding name", () => {
		const bindings: string[] = [];
		extractBindings("import type  Foo from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: public-api — "import type Foo from" names binding Foo, distinct from bare "import type from"
	it("extracts the binding name that follows a type-only default import", () => {
		const bindings: string[] = [];
		extractBindings("import type Foo from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});

	// test-contract: boundary — the default-name-to-from gap is \s+ (one or more), not a fixed single space
	it("accepts multiple spaces between a default binding name and from", () => {
		const bindings: string[] = [];
		extractBindings("import Foo  from './x'", bindings);
		expect(bindings).toEqual(["Foo"]);
	});
});

describe("extractBindings — per-item alias/type-strip mutants", () => {
	// test-contract: invariant — the per-item "type " strip is anchored to the item's own leading prefix only
	it("does not strip a 'type ' occurrence that is not the item's own leading prefix", () => {
		const bindings: string[] = [];
		extractBindings("import { prefixtype Foo } from './x'", bindings);
		expect(bindings).toEqual(["prefixtype Foo"]);
	});

	// test-contract: boundary — the per-item "type " strip consumes all whitespace via \s+, not exactly one char
	it("consumes all whitespace after a leading type keyword before evaluating the as-alias split", () => {
		const bindings: string[] = [];
		extractBindings("import { type  as Foo } from './x'", bindings);
		expect(bindings).toEqual(["as Foo"]);
	});

	// test-contract: boundary — the trailing as-alias whitespace is \s+; a double-as gap must resolve to one split
	it("resolves the alias split across a double 'as' with extra whitespace to the final segment", () => {
		const bindings: string[] = [];
		extractBindings("import { A as  as B } from './x'", bindings);
		expect(bindings).toEqual(["as B"]);
	});
});

describe("findDeadImports — comment-strip and buffer-state mutants", () => {
	// test-contract: bug — an under-stripped comment's leftover apostrophe must not fake the buffer's completion quote
	it("does not let a leftover apostrophe from an under-stripped inline comment complete the buffer early", () => {
		const content = ["import {", "  Foo // it's fine", "} from './source';"].join("\n");
		expect(findDeadImports(content)).toEqual(["Foo"]);
	});

	// test-contract: public-api — a plain three-line multiline import extracts its binding via buffer continuation
	it("extracts a binding from a plain three-line multiline import", () => {
		const content = ["import {", "  Foo", "} from './source';"].join("\n");
		expect(findDeadImports(content)).toEqual(["Foo"]);
	});

	// test-contract: invariant — the usage-body join is a real newline; adjacent body lines must not glue into one token
	it("keeps a word boundary between the last token of one body line and the first token of the next", () => {
		const content = ["import { Foo } from './source';", "const x = Foo", "Bar;"].join("\n");
		expect(findDeadImports(content)).toEqual([]);
	});
});

describe("findDeadImports — scanImportLine state-machine mutants", () => {
	// test-contract: invariant — the buffer completes only on an actual quote character, not any bare from-clause
	it("does not complete the buffer on a from-clause that has no quoted module specifier", () => {
		const content = ["import {", "  Foo", "} from bar", "Foo"].join("\n");
		expect(findDeadImports(content)).toEqual(["Foo"]);
	});

	// test-contract: invariant — the buffer reset value must be falsy so the next line does not re-enter buffer mode
	it("resets the buffer to a value that does not re-trigger buffer mode on the next line", () => {
		const content = [
			"import {",
			"  Foo",
			"} from './a';",
			"import { Bar } from './b';",
		].join("\n");
		expect(findDeadImports(content)).toEqual(["Foo", "Bar"]);
	});

	// test-contract: invariant — the multiline-start check is anchored, so "reimport {" must not match "import {"
	it("does not start a multiline buffer from a line that only contains, but does not start with, 'import {'", () => {
		const content = [
			"import { Foo } from './a';",
			"reimport {",
			"  Bar Foo",
			"} from './b';",
		].join("\n");
		expect(findDeadImports(content)).toEqual([]);
	});

	// test-contract: invariant — the direct-import check is anchored, so "reimport ..." must not match "import ..."
	it("does not treat a line that only contains, but does not start with, 'import ' as an import line", () => {
		const content = ["import { Foo } from './a';", "reimport Bar Foo from './b';"].join("\n");
		expect(findDeadImports(content)).toEqual([]);
	});
});

describe("findDeadImports — isNonImportPrefixLine mutants", () => {
	// test-contract: invariant — the "*/" prefix check is startsWith, not endsWith, on ordinary code text
	it("treats a line that merely ends with '*/' as real code, not a skippable prefix line", () => {
		const content = [
			"import { Foo } from './source';",
			"documentation */",
			"import { Bar } from './other';",
		].join("\n");
		expect(findDeadImports(content)).toEqual(["Foo"]);
	});
});
