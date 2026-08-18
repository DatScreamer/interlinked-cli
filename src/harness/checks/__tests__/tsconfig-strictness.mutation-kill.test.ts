// Mutation-kill campaign (W6 residue, fleet-r3 LEAN MODE) for
// `tsconfig-strictness.ts`. The companion `tsconfig-strictness.test.ts`
// covers the documented positive/negative/robustness contract; this file
// targets specific SURVIVED mutants (per `.interlinked/mutation-manifest.json`)
// whose observable divergence the existing suite happened not to assert on —
// mainly: (a) JSONC comment/trailing-comma regex edge shapes that only differ
// from a *slightly* different fixture, (b) the reported finding `.line`
// (never asserted anywhere before this file), (c) exact finding text, and
// (d) extends-chain depth/skip boolean-algebra corners.
//
// Every fixture below was traced by hand against the pristine source in
// `../tsconfig-strictness.ts` before being written — see the receipt JSONL
// (`scratch/fleet-r3/receipts/tsconfig-strictness.jsonl`) for the mutant-id
// -> rationale mapping. Several of the regex fixtures were additionally
// cross-checked with a throwaway Node driver
// (`scratch/fleet-r3/w6-regex-check.mjs`) reproducing the exact mutated
// regex/replacement against the same fixture text.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { checkTsconfigStrictness } from "../tsconfig-strictness.js";

describe("checkTsconfigStrictness — mutation-kill (W6 residue)", () => {
	let tmp: string;
	let configPath: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tscs-mutkill-"));
		configPath = join(tmp, "tsconfig.json");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	describe("safeJsoncParse — comment/trailing-comma stripping regexes", () => {
		// test-contract: bug — StringLiteral/quantifier mutants on /^\s*\/\/.*$/gm leave a leading zero-indent // comment un-stripped, corrupting JSON.parse.
		it("strips a leading zero-indent full-line // comment cleanly (parses, reports the one missing flag)", () => {
			const cfg = [
				"// comment",
				"{",
				'  "compilerOptions": {',
				'    "strict": true,',
				'    "noImplicitOverride": true,',
				'    "noImplicitReturns": true,',
				'    "noFallthroughCasesInSwitch": true',
				"  }",
				"}",
			].join("\n");
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});

		// test-contract: bug — the \s->\S mutant on /^\s*\/\/.*$/gm fails to strip an INDENTED full-line // comment that the real \s* handles.
		it("strips a 2-space-indented full-line // comment cleanly (parses, reports the one missing flag)", () => {
			const cfg = [
				"{",
				"  // indented comment",
				'  "compilerOptions": {',
				'    "strict": true,',
				'    "noImplicitOverride": true,',
				'    "noImplicitReturns": true,',
				'    "noFallthroughCasesInSwitch": true',
				"  }",
				"}",
			].join("\n");
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});

		// test-contract: bug — dropping the ^ anchor on /^\s*\/\/.*$/gm would wrongly strip a trailing "code, // comment" line the anchored regex must leave alone.
		it("does NOT strip a trailing inline // comment (anchored regex) — malformed JSON falls open with zero findings", () => {
			const cfg = [
				"{",
				'  "compilerOptions": {',
				'    "strict": true, // trailing note',
				'    "noImplicitOverride": true,',
				'    "noImplicitReturns": true,',
				'    "noFallthroughCasesInSwitch": true',
				"  }",
				"}",
			].join("\n");
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings).toEqual([]);
		});

		// test-contract: bug — [\s\S] character-class mutants and a ""->literal-text mutant on the block-comment regex leave "/* note */" un-stripped or corrupted.
		it("strips an inline block comment cleanly (parses, reports the one missing flag)", () => {
			const cfg = [
				"{",
				'  "compilerOptions": {',
				'    "strict": true, /* note */',
				'    "noImplicitOverride": true,',
				'    "noImplicitReturns": true,',
				'    "noFallthroughCasesInSwitch": true',
				"  }",
				"}",
			].join("\n");
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});

		// test-contract: bug — the \s*->\s mutant on the trailing-comma regex demands one whitespace char, so a comma with ZERO whitespace before `}` survives and breaks JSON.parse.
		it("strips a trailing comma with zero whitespace before the closing brace", () => {
			const cfg =
				'{"compilerOptions":{"strict":true,"noImplicitOverride":true,"noImplicitReturns":true,"noFallthroughCasesInSwitch":true,}}';
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});

		// test-contract: bug — replacing the trailing-comma regex's "$1" replacement with "" deletes the captured closing brace along with the comma.
		it("preserves the closing brace when stripping a trailing comma before it (newline + indent)", () => {
			const cfg =
				'{"compilerOptions":{"strict":true,"noImplicitOverride":true,"noImplicitReturns":true,"noFallthroughCasesInSwitch":true,\n  }\n}';
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});
	});

	describe("resolveExtendsPath — relative/absolute prefix guard", () => {
		// test-contract: bug — three mutants that neutralize the relative/absolute extends-ref guard would resolve a bare package-name extends ref against the config's own directory.
		it("does not resolve a bare (non-relative, non-absolute) extends reference even when a same-name file exists alongside it", () => {
			writeFileSync(
				join(tmp, "sneaky.json"),
				JSON.stringify({ compilerOptions: { exactOptionalPropertyTypes: true } }),
			);
			const derived = {
				extends: "sneaky",
				compilerOptions: {
					strict: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
					// exactOptionalPropertyTypes deliberately omitted — only
					// "sneaky.json" (which must NOT be consulted) sets it.
				},
			};
			writeFileSync(configPath, JSON.stringify(derived));

			const findings = checkTsconfigStrictness(JSON.stringify(derived), configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});
	});

	describe("mergeExtendsChain — MAX_DEPTH cap boundary", () => {
		// test-contract: bug — the MAX_DEPTH early-return's "?? {}" mutated to "&& {}" discards the truthy compilerOptions object returned exactly at the cap boundary.
		it("keeps the flags from the file exactly at the MAX_DEPTH cap boundary", () => {
			for (let i = 1; i <= 8; i++) {
				const isLast = i === 8;
				const next = isLast
					? {
							compilerOptions: {
								strict: true,
								exactOptionalPropertyTypes: true,
								noImplicitOverride: true,
								noImplicitReturns: true,
								noFallthroughCasesInSwitch: true,
							},
						}
					: { extends: `./b${i + 1}.json` };
				writeFileSync(join(tmp, `b${i}.json`), JSON.stringify(next));
			}
			const root = { extends: "./b1.json" };
			writeFileSync(configPath, JSON.stringify(root));

			const findings = checkTsconfigStrictness(JSON.stringify(root), configPath);
			expect(findings).toEqual([]);
		});

		// test-contract: bug — depth-bookkeeping mutants (increment->decrement; cap guard forced false; >= relaxed to >) let the walk read past the 8-hop MAX_DEPTH boundary.
		it("drops flags declared only past the 8-hop MAX_DEPTH boundary (9-file chain)", () => {
			for (let i = 1; i <= 9; i++) {
				const isLast = i === 9;
				const next = isLast
					? {
							compilerOptions: {
								strict: true,
								exactOptionalPropertyTypes: true,
								noImplicitOverride: true,
								noImplicitReturns: true,
								noFallthroughCasesInSwitch: true,
							},
						}
					: { extends: `./b${i + 1}.json` };
				writeFileSync(join(tmp, `b${i}.json`), JSON.stringify(next));
			}
			const root = { extends: "./b1.json" };
			writeFileSync(configPath, JSON.stringify(root));

			const findings = checkTsconfigStrictness(JSON.stringify(root), configPath);
			expect(findings).toHaveLength(4);
		});
	});

	describe("isTsconfigBasename — anchor regex", () => {
		// test-contract: bug — dropping the trailing $ anchor on the basename regex lets "tsconfig.jsonx" match as a prefix, even though it is not a tsconfig file.
		it("does NOT treat tsconfig.jsonx as a tsconfig file (trailing $ anchor)", () => {
			const content = JSON.stringify({ compilerOptions: { strict: true } });
			const findings = checkTsconfigStrictness(content, join(tmp, "tsconfig.jsonx"));
			expect(findings).toEqual([]);
		});

		// test-contract: bug — dropping the leading ^ anchor on the basename regex lets "xtsconfig.json" match as a suffix, even though the basename is not exactly tsconfig(.variant).json.
		it("does NOT treat xtsconfig.json as a tsconfig file (leading ^ anchor)", () => {
			const content = JSON.stringify({ compilerOptions: { strict: true } });
			const findings = checkTsconfigStrictness(content, join(tmp, "xtsconfig.json"));
			expect(findings).toEqual([]);
		});
	});

	describe("isInsideNodeModules — separator normalization", () => {
		// test-contract: bug — startsWith("node_modules/") mutated to endsWith("node_modules/") fails a bare relative node_modules/... path with no leading slash.
		it("still skips a bare relative node_modules/... path with no leading slash", () => {
			const content = JSON.stringify({ compilerOptions: { strict: true } });
			const findings = checkTsconfigStrictness(content, "node_modules/some-pkg/tsconfig.json");
			expect(findings).toEqual([]);
		});

		// test-contract: bug — the backslash-to-forward-slash replacement "/" mutated to "" deletes Windows separators instead of normalizing them.
		it("still skips a Windows-style backslash node_modules path", () => {
			const content = JSON.stringify({ compilerOptions: { strict: true } });
			const winPath = "repo\\node_modules\\pkg/tsconfig.json";
			const findings = checkTsconfigStrictness(content, winPath);
			expect(findings).toEqual([]);
		});
	});

	describe("findCompilerOptionsLine — exact reported line", () => {
		// test-contract: bug — nine independent mutants on the compilerOptions line-scan loop collapse it to always-return-1 (or undefined); no prior test asserts the exact reported line.
		it("reports the exact 1-indexed line of the compilerOptions block, not line 1", () => {
			const cfg = [
				"{",
				'  "unrelated": true,',
				'  "compilerOptions": {',
				'    "strict": true',
				"  }",
				"}",
			].join("\n");
			writeFileSync(configPath, cfg);

			const findings = checkTsconfigStrictness(cfg, configPath);
			expect(findings.length).toBeGreaterThan(0);
			for (const f of findings) {
				expect(f.line).toBe(3);
			}
		});
	});

	describe("checkTsconfigStrictness — finding text and skip-condition boolean algebra", () => {
		// test-contract: public-api — emptying the middle template segment still leaves the flag name and "(Not covered..." tail intact under substring checks; assert the exact finding text instead.
		it("produces the exact documented finding text for a missing exactOptionalPropertyTypes", () => {
			const cfg = {
				compilerOptions: {
					strict: true,
					noImplicitOverride: true,
					noImplicitReturns: true,
					noFallthroughCasesInSwitch: true,
				},
			};
			writeFileSync(configPath, JSON.stringify(cfg));

			const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toBe(
				"[tsconfig_strictness] `compilerOptions.exactOptionalPropertyTypes` is not enabled. " +
					'Add `"exactOptionalPropertyTypes": true` — ' +
					"`{ x?: number }` no longer silently accepts `{ x: undefined }` — optional means absent, not present-and-undefined. " +
					"(Not covered by `strict: true`.)",
			);
		});

		// test-contract: boundary — Object.keys(ownCompiler).length > 0 mutants (forced true; flipped <= 0; flipped >= 0) treat an EMPTY compilerOptions object as "has compiler options", wrongly firing the composite-root skip.
		it("skips (composite-root shape) when compilerOptions is present but empty, with references present", () => {
			const cfg = {
				compilerOptions: {},
				references: [{ path: "./sub" }],
			};
			writeFileSync(configPath, JSON.stringify(cfg));

			const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
			expect(findings).toEqual([]);
		});

		// test-contract: boundary — forcing the skip's own+inherited negation to literal true would skip whenever references is present, even with real compilerOptions that should be evaluated.
		it("does NOT skip when compilerOptions is genuinely populated, even with references present", () => {
			const cfg = {
				compilerOptions: { strict: true },
				references: [{ path: "./sub" }],
			};
			writeFileSync(configPath, JSON.stringify(cfg));

			const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
			expect(findings).toHaveLength(4);
		});

		// test-contract: boundary — AND->OR (or forcing the inherited half to constant false) wrongly skips when own compilerOptions is absent but the extends chain genuinely contributes one.
		it("does NOT skip when own compilerOptions is absent but the extends chain contributes one (references present)", () => {
			const basePath = join(tmp, "tsconfig.base.json");
			writeFileSync(
				basePath,
				JSON.stringify({
					compilerOptions: {
						strict: true,
						noImplicitOverride: true,
						noImplicitReturns: true,
						noFallthroughCasesInSwitch: true,
					},
				}),
			);
			const derived = {
				extends: "./tsconfig.base.json",
				references: [{ path: "./sub" }],
			};
			writeFileSync(configPath, JSON.stringify(derived));

			const findings = checkTsconfigStrictness(JSON.stringify(derived), configPath);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).text).toContain("exactOptionalPropertyTypes");
		});

		// test-contract: boundary — forcing the references-length check to true (or relaxing > to >=, always-true for a non-negative length) treats an EMPTY references array as "has references", wrongly firing the skip.
		it("does NOT skip on an empty references array with no compilerOptions", () => {
			const cfg = { references: [] };
			writeFileSync(configPath, JSON.stringify(cfg));

			const findings = checkTsconfigStrictness(JSON.stringify(cfg), configPath);
			expect(findings).toHaveLength(4);
		});
	});
});
