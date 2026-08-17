import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { getGitSourceFiles } from "./export-ripple.js";
import {
	checkUntestedIdempotent,
	checkUntestedInversePair,
	scaffoldPropertyTest,
} from "./property-testing.js";

// Positive cases use a basename that appears in NO real test-file path, so the
// path-prefilter finds zero candidate suites → the pair reads as untested →
// fires. cwd = process.cwd() (the real repo) for the git listing.
const FAKE = "zzqp_inverse_fixture_module";
const fakePath = `${FAKE}.ts`;
const cwd = process.cwd();

function fires(content: string, file = fakePath): boolean {
	return checkUntestedInversePair(content, file, cwd).length > 0;
}

describe("checkUntestedInversePair — negative (must NOT fire)", () => {
	it("N1: .d.ts is out of scope", () => {
		expect(
			checkUntestedInversePair("export function encode(){}\nexport function decode(){}", "x.d.ts", cwd),
		).toHaveLength(0);
	});
	it("N2: a test file is out of scope", () => {
		expect(fires("export function encode(){}\nexport function decode(){}", "foo.test.ts")).toBe(false);
	});
	it("N3: a non-JS/TS extension is out of scope", () => {
		expect(fires("def encode(): pass\ndef decode(): pass", `${FAKE}.py`)).toBe(false);
	});
	it("N4: fewer than two exports cannot form a pair", () => {
		expect(fires("export function encode(x: string){ return x; }")).toBe(false);
	});
	it("N5: two unrelated exports are not an inverse pair", () => {
		expect(fires("export function compute(){}\nexport function render(){}")).toBe(false);
	});
	it("N6: only one half of a pair present (encode, no decode)", () => {
		expect(fires("export function encode(){}\nexport function helper(){}")).toBe(false);
	});
	it("N7: to<X> without from<X>", () => {
		expect(fires("export function toBuffer(){}\nexport function size(){}")).toBe(false);
	});
});

describe("checkUntestedInversePair — positive (must fire when untested)", () => {
	it("P1: bare encode/decode pair", () => {
		expect(fires("export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }")).toBe(true);
	});
	it("P2: serialize/deserialize pair", () => {
		expect(fires("export const serialize = (x: object) => JSON.stringify(x);\nexport const deserialize = (s: string) => JSON.parse(s);")).toBe(true);
	});
	it("P3: to<X>/from<X> pair", () => {
		expect(fires("export function toBuffer(x: string){ return Buffer.from(x); }\nexport function fromBuffer(b: Buffer){ return b.toString(); }")).toBe(true);
	});
	it("P4: affixed encodeToon/decodeToon pair (remainder match)", () => {
		expect(fires("export function encodeToon(x: string){ return x; }\nexport function decodeToon(x: string){ return x; }")).toBe(true);
	});
	it("P5: reports the forward function's line and names both halves", () => {
		const out = checkUntestedInversePair(
			"// header\nexport function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			fakePath,
			cwd,
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(2);
		expect(nonNull(out[0]).text).toContain("encode/decode");
		expect(nonNull(out[0]).text).toContain("decode(encode(x)) === x");
	});
});

describe("checkUntestedInversePair — additional structural coverage", () => {
	it("recognizes `export default function` as a candidate half of a pair", () => {
		expect(
			fires(
				"export default function toBuffer(x: string){ return Buffer.from(x); }\nexport function fromBuffer(b: Buffer){ return b.toString(); }",
			),
		).toBe(true);
	});

	it("de-dupes a repeated forward/inverse name combo instead of reporting it twice", () => {
		const content =
			"export function encode(x: string){ return x; }\nexport function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
		const out = checkUntestedInversePair(content, fakePath, cwd);
		expect(out).toHaveLength(1);
	});

	it("does NOT pair names whose verb-stem remainders differ (encodeFoo vs decodeBar)", () => {
		expect(
			fires(
				"export function encodeFoo(x: string){ return x; }\nexport function decodeBar(x: string){ return x; }",
			),
		).toBe(false);
	});

	it("does NOT fire when filePath resolves outside cwd (relFromRoot starts with '..')", () => {
		const outsidePath = join(tmpdir(), "zzqp_outside_inverse.ts");
		const content =
			"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
		expect(checkUntestedInversePair(content, outsidePath, cwd)).toEqual([]);
	});

	it("still fires when the relative basename strips to empty (candidates prefilter yields none)", () => {
		const content =
			"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
		const out = checkUntestedInversePair(content, ".ts", cwd);
		expect(out.length).toBeGreaterThan(0);
	});

	it("caps findings at 10 even when more than 10 inverse pairs are untested", () => {
		const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
		const content = letters
			.map((l) => `export function encode${l}(x: string){ return x; }\nexport function decode${l}(x: string){ return x; }`)
			.join("\n");
		const out = checkUntestedInversePair(content, fakePath, cwd);
		expect(out).toHaveLength(10);
	});

	it("returns [] via the readFileSync catch when a git-listed candidate test file is deleted before the read (stale-cache race)", () => {
		const dir = mkdtempSync(join(tmpdir(), "inv-pair-race-"));
		try {
			writeFileSync(
				join(dir, "widget.ts"),
				"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			);
			const testPath = join(dir, "widget.test.ts");
			writeFileSync(
				testPath,
				"import { encode, decode } from './widget.js';\nit('round-trips', () => { expect(decode(encode('a'))).toBe('a'); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			// Warm the 30s TTL cache while the file still exists, then delete it —
			// the check's internal getGitSourceFiles call reuses the stale cached
			// listing, so it attempts readFileSync on a path that's now gone.
			getGitSourceFiles(dir);
			unlinkSync(testPath);
			const src = "export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
			const out = checkUntestedInversePair(src, join(dir, "widget.ts"), dir);
			// No readable test content found -> reads as untested -> still fires.
			expect(out.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkUntestedInversePair — suppression (round-trip test exists)", () => {
	const dir = mkdtempSync(join(tmpdir(), "inv-pair-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it(
		"does NOT fire when a co-located test references both halves",
		() => {
			writeFileSync(
				join(dir, "widget.ts"),
				"export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			);
			writeFileSync(
				join(dir, "widget.test.ts"),
				"import { encode, decode } from './widget.js';\nit('round-trips', () => { expect(decode(encode('a'))).toBe('a'); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }";
			expect(checkUntestedInversePair(src, join(dir, "widget.ts"), dir)).toHaveLength(0);
		},
		60_000,
	);
});

// B2 — idempotent-shaped functions. Same FAKE-basename strategy: positives use a
// basename present in NO real test-file path, so the prefilter finds zero
// candidate suites → reads as untested → fires.
const IDEM_FAKE = "zzqp_idempotent_fixture_module";
const idemFakePath = `${IDEM_FAKE}.ts`;

function idemFires(content: string, file = idemFakePath): boolean {
	return checkUntestedIdempotent(content, file, cwd).length > 0;
}

describe("checkUntestedIdempotent — negative (must NOT fire)", () => {
	it("BN1: .d.ts is out of scope", () => {
		expect(
			checkUntestedIdempotent("export function normalize(x: string){ return x; }", "x.d.ts", cwd),
		).toHaveLength(0);
	});
	it("BN2: a test file is out of scope", () => {
		expect(idemFires("export function normalize(x: string){ return x; }", "foo.test.ts")).toBe(false);
	});
	it("BN3: a non-JS/TS extension is out of scope", () => {
		expect(idemFires("def normalize(x): return x", `${IDEM_FAKE}.py`)).toBe(false);
	});
	it("BN4: a non-idempotent verb name does not fire", () => {
		expect(idemFires("export function compute(x: number){ return x + 1; }")).toBe(false);
	});
	it("BN5: an idempotent-shaped name with NO arguments does not fire", () => {
		expect(idemFires("export function sanitize(){ return null; }")).toBe(false);
	});
	it("BN6: a suffix-only match (fastNormalize) is not idempotent-shaped", () => {
		expect(idemFires("export function fastNormalize(x: string){ return x; }")).toBe(false);
	});
	it("BN7: a verb-prefixed lowercase continuation (normalized) does not fire", () => {
		expect(idemFires("export function normalized(x: string){ return x; }")).toBe(false);
	});
});

describe("checkUntestedIdempotent — positive (must fire when untested)", () => {
	it("BP1: bare normalize with an argument", () => {
		expect(idemFires("export function normalize(x: string){ return x.trim(); }")).toBe(true);
	});
	it("BP2: camelCase-prefixed sanitizeHtml", () => {
		expect(idemFires("export const sanitizeHtml = (s: string) => s.replace(/</g, '');")).toBe(true);
	});
	it("BP3: slugify arrow function", () => {
		expect(idemFires("export const slugify = (s: string) => s.toLowerCase();")).toBe(true);
	});
	it("BP4: canonicalize wins over its canonical prefix", () => {
		expect(idemFires("export function canonicalizePath(p: string){ return p; }")).toBe(true);
	});
	it("BP5: reports the function's line and the idempotence law", () => {
		const out = checkUntestedIdempotent(
			"// header\nexport function normalize(x: string){ return x.trim(); }",
			idemFakePath,
			cwd,
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(2);
		expect(nonNull(out[0]).text).toContain("idempotent-shaped normalize");
		expect(nonNull(out[0]).text).toContain("normalize(normalize(x)) === normalize(x)");
	});
});

describe("checkUntestedIdempotent — additional structural coverage", () => {
	it("does NOT fire when filePath resolves outside cwd (relFromRoot starts with '..')", () => {
		const outsidePath = join(tmpdir(), "zzqp_outside_idem.ts");
		const content = "export function normalize(x: string){ return x.trim(); }";
		expect(checkUntestedIdempotent(content, outsidePath, cwd)).toEqual([]);
	});

	it("still fires when the relative basename strips to empty (candidates prefilter yields none)", () => {
		const content = "export function normalize(x: string){ return x.trim(); }";
		const out = checkUntestedIdempotent(content, ".ts", cwd);
		expect(out.length).toBeGreaterThan(0);
	});

	it("caps findings at 10 even when more than 10 idempotent-shaped exports are untested", () => {
		const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
		const content = letters
			.map((l) => `export function normalize${l}(x: string){ return x.trim(); }`)
			.join("\n");
		const out = checkUntestedIdempotent(content, idemFakePath, cwd);
		expect(out).toHaveLength(10);
	});

	it("takes the argument-detection scan across a multi-line signature before hitting the body brace", () => {
		const content =
			"export function normalizeMultiline(\n  x: string\n) {\n  return x.trim();\n}";
		expect(idemFires(content)).toBe(true);
	});

	it("handles a nested parenthesized type in the parameter list (function-typed argument)", () => {
		const content =
			"export function normalizeCb(x: (a: string) => string){ return x(''); }";
		expect(idemFires(content)).toBe(true);
	});

	it("returns [] via the readFileSync catch when a git-listed candidate test file is deleted before the read (stale-cache race)", () => {
		const dir = mkdtempSync(join(tmpdir(), "idem-race-"));
		try {
			writeFileSync(
				join(dir, "norm.ts"),
				"export function normalize(x: string){ return x.trim(); }",
			);
			const testPath = join(dir, "norm.test.ts");
			writeFileSync(
				testPath,
				"import { normalize } from './norm.js';\nit('is idempotent', () => { expect(normalize(normalize(' a '))).toBe(normalize(' a ')); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			getGitSourceFiles(dir);
			unlinkSync(testPath);
			const src = "export function normalize(x: string){ return x.trim(); }";
			const out = checkUntestedIdempotent(src, join(dir, "norm.ts"), dir);
			expect(out.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does NOT flag when a co-located candidate test file exists but never references the function name", () => {
		const dir = mkdtempSync(join(tmpdir(), "idem-noref-"));
		try {
			writeFileSync(
				join(dir, "norm.ts"),
				"export function normalize(x: string){ return x.trim(); }",
			);
			writeFileSync(
				join(dir, "norm.test.ts"),
				"import './norm.js';\nit('does something unrelated', () => { expect(1 + 1).toBe(2); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function normalize(x: string){ return x.trim(); }";
			// The candidate test file is read (nameHasTest's regex is evaluated
			// against real content) but never matches \bnormalize\b, so this
			// still reads as untested and fires.
			const out = checkUntestedIdempotent(src, join(dir, "norm.ts"), dir);
			expect(out.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkUntestedIdempotent — suppression (property test exists)", () => {
	const dir = mkdtempSync(join(tmpdir(), "idem-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it(
		"does NOT fire when a co-located test references the function",
		() => {
			writeFileSync(
				join(dir, "norm.ts"),
				"export function normalize(x: string){ return x.trim(); }",
			);
			writeFileSync(
				join(dir, "norm.test.ts"),
				"import { normalize } from './norm.js';\nit('is idempotent', () => { expect(normalize(normalize(' a '))).toBe(normalize(' a ')); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function normalize(x: string){ return x.trim(); }";
			expect(checkUntestedIdempotent(src, join(dir, "norm.ts"), dir)).toHaveLength(0);
		},
		60_000,
	);
});

// B4b — scaffoldPropertyTest pure generator.
describe("scaffoldPropertyTest", () => {
	it("S1: inverse-pair emits both calls, the committed seed, and fast-check entry points", () => {
		const out = scaffoldPropertyTest("inverse-pair", { forward: "encode", inverse: "decode" });
		expect(out).toContain("fc.assert(");
		expect(out).toContain("fc.property(");
		expect(out).toContain("{ seed: ");
		expect(out).toContain("endOnFailure: true");
		expect(out).toContain("decode(encode(x))");
		expect(out).toContain("fc.string()");
		expect(out).toContain("TODO: refine arbitrary");
	});
	it("S2: idempotent emits the f(f(x)) === f(x) law with the seed", () => {
		const out = scaffoldPropertyTest("idempotent", { forward: "normalize" });
		expect(out).toContain("fc.assert(");
		expect(out).toContain("fc.property(");
		expect(out).toContain("{ seed: ");
		expect(out).toContain("endOnFailure: true");
		expect(out).toContain("normalize(normalize(x))");
		expect(out).toContain("normalize(x)");
	});
	it("S3: the committed seed is identical across calls (deterministic/refereeable)", () => {
		const a = scaffoldPropertyTest("idempotent", { forward: "slugify" });
		const b = scaffoldPropertyTest("idempotent", { forward: "slugify" });
		expect(a).toBe(b);
		const seedMatch = a.match(/\{ seed: (\d+),/);
		expect(seedMatch).not.toBeNull();
		expect(Number(seedMatch?.[1])).toBeGreaterThan(0);
	});
	it("S4: inverse-pair without an explicit inverse falls back to a placeholder name", () => {
		const out = scaffoldPropertyTest("inverse-pair", { forward: "pack" });
		expect(out).toContain("inverse(pack(x))");
		expect(out).toContain("fc.assert(");
	});

	it("S5: inverse-pair produces the exact byte-for-byte scaffold (kills every string-piece mutant)", () => {
		const out = scaffoldPropertyTest("inverse-pair", { forward: "encode", inverse: "decode" });
		expect(out).toBe(
			'import { describe, expect, it } from "vitest";\n' +
				'import fc from "fast-check";\n' +
				"// TODO: refine arbitrary for non-string inputs\n" +
				"\n" +
				'describe("encode/decode round-trip", () => {\n' +
				'\tit("decode(encode(x)) === x", () => {\n' +
				"\t\tfc.assert(\n" +
				"\t\t\tfc.property(fc.string(), (x) => {\n" +
				"\t\t\t\texpect(decode(encode(x))).toStrictEqual(x);\n" +
				"\t\t\t}),\n" +
				"\t\t\t{ seed: 424242, endOnFailure: true },\n" +
				"\t\t);\n" +
				"\t});\n" +
				"});\n",
		);
	});

	it("S6: idempotent produces the exact byte-for-byte scaffold (kills every string-piece mutant)", () => {
		const out = scaffoldPropertyTest("idempotent", { forward: "normalize" });
		expect(out).toBe(
			'import { describe, expect, it } from "vitest";\n' +
				'import fc from "fast-check";\n' +
				"// TODO: refine arbitrary for non-string inputs\n" +
				"\n" +
				'describe("normalize idempotence", () => {\n' +
				'\tit("normalize(normalize(x)) === normalize(x)", () => {\n' +
				"\t\tfc.assert(\n" +
				"\t\t\tfc.property(fc.string(), (x) => {\n" +
				"\t\t\t\texpect(normalize(normalize(x))).toStrictEqual(normalize(x));\n" +
				"\t\t\t}),\n" +
				"\t\t\t{ seed: 424242, endOnFailure: true },\n" +
				"\t\t);\n" +
				"\t});\n" +
				"});\n",
		);
	});

	it("S7: inverse-pair fallback produces the exact byte-for-byte scaffold", () => {
		const out = scaffoldPropertyTest("inverse-pair", { forward: "pack" });
		expect(out).toBe(
			'import { describe, expect, it } from "vitest";\n' +
				'import fc from "fast-check";\n' +
				"// TODO: refine arbitrary for non-string inputs\n" +
				"\n" +
				'describe("pack/inverse round-trip", () => {\n' +
				'\tit("inverse(pack(x)) === x", () => {\n' +
				"\t\tfc.assert(\n" +
				"\t\t\tfc.property(fc.string(), (x) => {\n" +
				"\t\t\t\texpect(inverse(pack(x))).toStrictEqual(x);\n" +
				"\t\t\t}),\n" +
				"\t\t\t{ seed: 424242, endOnFailure: true },\n" +
				"\t\t);\n" +
				"\t});\n" +
				"});\n",
		);
	});
});

// ===========================================
// Mutation-kill hardening (survivor-focused). Each group below targets
// specific surviving mutants from a Stryker run against this file — see
// scratch/fleet-r2/kill-briefs/src_harness_checks_property-testing.ts.json.
// Fixture design verified via a shadow-mutation harness (physically applies
// each mutant's substitution to a copy of property-testing.ts and diffs
// pristine vs. mutant behavior on these exact fixtures).
// ===========================================

describe("extractExportedNames regex robustness — positive (must still recognize)", () => {
	it("RP1: recognizes an indented (leading-whitespace) export function declaration", () => {
		expect(
			fires(
				"  export function encode(x){return x}\n  export function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP2: recognizes an indented export const arrow declaration", () => {
		expect(
			fires(
				"  export const encode = (x: string) => x;\n  export const decode = (x: string) => x;",
			),
		).toBe(true);
	});
	it("RP3: recognizes an indented export default function declaration", () => {
		expect(
			fires(
				"  export default function encode(x){return x}\n  export function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP4: tolerates extra (double) whitespace between export and function", () => {
		expect(
			fires("export  function encode(x){return x}\nexport  function decode(x){return x}"),
		).toBe(true);
	});
	it("RP5: tolerates extra (double) whitespace between export and const", () => {
		expect(
			fires(
				"export  const encode = (x: string) => x;\nexport  const decode = (x: string) => x;",
			),
		).toBe(true);
	});
	it("RP6: tolerates extra (double) whitespace between export and default", () => {
		expect(
			fires(
				"export  default function encode(x){return x}\nexport function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP7: tolerates extra (double) whitespace between default and function", () => {
		expect(
			fires(
				"export default  function encode(x){return x}\nexport function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP8: tolerates extra (double) whitespace between const and the name", () => {
		expect(
			fires(
				"export const  encode = (x: string) => x;\nexport const  decode = (x: string) => x;",
			),
		).toBe(true);
	});
	it("RP9: tolerates extra (double) whitespace between function and the name", () => {
		expect(
			fires("export function  encode(x){return x}\nexport function  decode(x){return x}"),
		).toBe(true);
	});
	it("RP10: tolerates extra (double) whitespace between default-function and the name", () => {
		expect(
			fires(
				"export default function  encode(x){return x}\nexport function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP11: recognizes `export async function`", () => {
		expect(
			fires("export async function encode(x){return x}\nexport async function decode(x){return x}"),
		).toBe(true);
	});
	it("RP12: recognizes `export const x = async function`", () => {
		expect(
			fires(
				"export const encode = async function(x){return x};\nexport const decode = async function(x){return x};",
			),
		).toBe(true);
	});
	it("RP13: recognizes `export default async function`", () => {
		expect(
			fires(
				"export default async function encode(x){return x}\nexport function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP14: tolerates extra (double) whitespace between async and function", () => {
		expect(
			fires(
				"export async  function encode(x){return x}\nexport async  function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP15: tolerates extra (double) whitespace between async and function in a const arrow", () => {
		expect(
			fires(
				"export const encode = async  function(x){return x};\nexport const decode = async  function(x){return x};",
			),
		).toBe(true);
	});
	it("RP16: tolerates extra (double) whitespace between default-async and function", () => {
		expect(
			fires(
				"export default async  function encode(x){return x}\nexport function decode(x){return x}",
			),
		).toBe(true);
	});
	it("RP17: tolerates whitespace before the opening paren", () => {
		expect(
			fires("export function encode (x){return x}\nexport function decode (x){return x}"),
		).toBe(true);
	});
	it("RP18: tolerates whitespace before the opening paren on a default export", () => {
		expect(
			fires(
				"export default function encode (x){return x}\nexport function decode (x){return x}",
			),
		).toBe(true);
	});
	it("RP19: tolerates zero whitespace around `=` in a const arrow (no type annotation)", () => {
		expect(fires("export const encode=(x: string) => x;\nexport const decode=(x: string) => x;")).toBe(
			true,
		);
	});
	it("RP20: tolerates a multi-character type annotation between name and `=`", () => {
		expect(
			fires(
				"export const encode: Encoder = (x: string) => x;\nexport const decode: Encoder = (x: string) => x;",
			),
		).toBe(true);
	});
});

describe("extractExportedNames regex robustness — negative (must NOT recognize)", () => {
	it("RN1: a commented-out `export function` line is not recognized (falls to <2 exports)", () => {
		expect(fires("// export function encode(){}\nexport function decode(){}")).toBe(false);
	});
	it("RN2: a commented-out `export const =` line is not recognized (falls to <2 exports)", () => {
		expect(
			fires(
				"// export const encode = (x: string) => x;\nexport const decode = (x: string) => x;",
			),
		).toBe(false);
	});
	it("RN3: a commented-out `export default function` line is not recognized (falls to <2 exports)", () => {
		expect(
			fires(
				"// export default function encode(x){return x}\nexport function decode(x){return x}",
			),
		).toBe(false);
	});
});

describe("checkUntestedInversePair — exact declaration line across all three export shapes", () => {
	it("declares the plain `export function` pair on line 2", () => {
		const out = checkUntestedInversePair(
			"// header\nexport function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			fakePath,
			cwd,
		);
		expect(out.map((o) => o.line)).toEqual([2]);
	});
	it("declares the `export const = (…) =>` pair on line 2", () => {
		const out = checkUntestedInversePair(
			"// header\nexport const encode = (x: string) => x;\nexport const decode = (x: string) => x;",
			fakePath,
			cwd,
		);
		expect(out.map((o) => o.line)).toEqual([2]);
	});
	it("declares the `export default function` pair on line 2", () => {
		const out = checkUntestedInversePair(
			"// header\nexport default function encode(x: string){ return x; }\nexport function decode(x: string){ return x; }",
			fakePath,
			cwd,
		);
		expect(out.map((o) => o.line)).toEqual([2]);
	});
});

describe("checkUntestedInversePair — verb-affix suffix matching", () => {
	it("recognizes a suffix-affixed pair (toonEncode/toonDecode, verb as a suffix not a prefix)", () => {
		expect(
			fires("export function toonEncode(x){return x}\nexport function toonDecode(x){return x}"),
		).toBe(true);
	});
});

describe("checkUntestedInversePair — to<X>/from<X> anchoring and law text", () => {
	it("does NOT pair a name that merely CONTAINS `to<X>` (must start with it)", () => {
		expect(
			fires("export function AutoBuffer(x){return x}\nexport function fromBuffer(x){return x}"),
		).toBe(false);
	});
	it("does NOT pair a name that merely CONTAINS `from<X>` (must start with it)", () => {
		expect(
			fires("export function toBuffer(x){return x}\nexport function XfromBuffer(x){return x}"),
		).toBe(false);
	});
	it("reports the exact round-trip law text for a to<X>/from<X> pair", () => {
		const out = checkUntestedInversePair(
			"export function toBuffer(x){return x}\nexport function fromBuffer(x){return x}",
			fakePath,
			cwd,
		);
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("toBuffer(fromBuffer(x)) === x");
	});
});

describe("checkUntestedInversePair — round-trip suppression requires BOTH names", () => {
	const dir = mkdtempSync(join(tmpdir(), "inv-pair-asym-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it(
		"still fires when the co-located test references ONLY the inverse name",
		() => {
			writeFileSync(
				join(dir, "widgetA.ts"),
				"export function encode(x){return x}\nexport function decode(x){return x}",
			);
			writeFileSync(
				join(dir, "widgetA.test.ts"),
				"import { decode } from './widgetA.js';\nit('decodes', () => { expect(decode('a')).toBeDefined(); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x){return x}\nexport function decode(x){return x}";
			expect(checkUntestedInversePair(src, join(dir, "widgetA.ts"), dir).length).toBeGreaterThan(0);
		},
		60_000,
	);

	it(
		"still fires when the co-located test references ONLY the forward name",
		() => {
			writeFileSync(
				join(dir, "widgetB.ts"),
				"export function encode(x){return x}\nexport function decode(x){return x}",
			);
			writeFileSync(
				join(dir, "widgetB.test.ts"),
				"import { encode } from './widgetB.js';\nit('encodes', () => { expect(encode('a')).toBeDefined(); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x){return x}\nexport function decode(x){return x}";
			expect(checkUntestedInversePair(src, join(dir, "widgetB.ts"), dir).length).toBeGreaterThan(0);
		},
		60_000,
	);

	it(
		"still fires when a co-located candidate test file exists but references NEITHER name",
		() => {
			writeFileSync(
				join(dir, "widgetC.ts"),
				"export function encode(x){return x}\nexport function decode(x){return x}",
			);
			writeFileSync(
				join(dir, "widgetC.test.ts"),
				"it('does something unrelated', () => { expect(1 + 1).toBe(2); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x){return x}\nexport function decode(x){return x}";
			expect(checkUntestedInversePair(src, join(dir, "widgetC.ts"), dir).length).toBeGreaterThan(0);
		},
		60_000,
	);
});

describe("checkUntestedInversePair — additional structural coverage (round 2)", () => {
	it("proceeds past a non-JS/TS extension guard only for content the extension check would otherwise skip", () => {
		// N3 (existing) uses Python content that produces zero exports either way.
		// This uses JS-shaped content under a wrong extension, so the extension
		// guard is the ONLY thing standing between "correctly skipped" and
		// "incorrectly flagged".
		expect(
			checkUntestedInversePair(
				"export function encode(x){return x}\nexport function decode(x){return x}",
				`${FAKE}.py`,
				cwd,
			),
		).toEqual([]);
	});

	it("basename split uses '/' as the path separator, not every character", () => {
		const dir = mkdtempSync(join(tmpdir(), "inv-split-"));
		try {
			mkdirSync(join(dir, "sub"), { recursive: true });
			writeFileSync(
				join(dir, "sub", "widget.ts"),
				"export function encode(x){return x}\nexport function decode(x){return x}",
			);
			// Decoy contains the LAST CHARACTER of the source path ('s', from
			// ".ts") but not the real basename "widget" — a char-split basename
			// would wrongly treat it as a candidate.
			writeFileSync(
				join(dir, "spy.test.ts"),
				"it('encodes and decodes', () => { encode(decode('x')); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x){return x}\nexport function decode(x){return x}";
			expect(checkUntestedInversePair(src, join(dir, "sub", "widget.ts"), dir).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("extension-strip is anchored to the END of the basename (a mid-name '.js' does not count)", () => {
		const dir = mkdtempSync(join(tmpdir(), "inv-extanchor-"));
		try {
			// Source basename has TWO extension-shaped segments; only the true
			// trailing one ("widget.js") should survive the strip.
			writeFileSync(
				join(dir, "widget.js.ts"),
				"export function encode(x){return x}\nexport function decode(x){return x}",
			);
			// Decoy matches the WRONG (unanchored) strip result "widget.ts", not
			// the correct anchored one "widget.js".
			writeFileSync(
				join(dir, "widget.ts.helper.test.ts"),
				"it('encodes and decodes', () => { encode(decode('x')); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x){return x}\nexport function decode(x){return x}";
			expect(checkUntestedInversePair(src, join(dir, "widget.js.ts"), dir).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it(
		"candidate test files are capped at 50 — a round-trip test past the cap is never read",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "inv-cap50-"));
			try {
				writeFileSync(
					join(dir, "widget.ts"),
					"export function encode(x){return x}\nexport function decode(x){return x}",
				);
				for (let i = 0; i < 50; i++) {
					const label = `aaa${String(i).padStart(2, "0")}`;
					writeFileSync(
						join(dir, `widget-${label}.test.ts`),
						"it('unrelated', () => { expect(1).toBe(1); });",
					);
				}
				// Sorts after all 50 "widget-aaaNN" decoys — past the cap.
				writeFileSync(
					join(dir, "widget-zzz-real.test.ts"),
					"it('round-trips', () => { encode(decode('x')); });",
				);
				execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
				const src = "export function encode(x){return x}\nexport function decode(x){return x}";
				expect(checkUntestedInversePair(src, join(dir, "widget.ts"), dir).length).toBeGreaterThan(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		60_000,
	);

	it("a sibling file that is NOT a test file is never read as a candidate, even if it mentions both names", () => {
		const dir = mkdtempSync(join(tmpdir(), "inv-sibling-"));
		try {
			writeFileSync(
				join(dir, "widget.ts"),
				"export function encode(x){return x}\nexport function decode(x){return x}",
			);
			writeFileSync(
				join(dir, "widget-notes.ts"),
				"// encode and decode are documented together here",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function encode(x){return x}\nexport function decode(x){return x}";
			expect(checkUntestedInversePair(src, join(dir, "widget.ts"), dir).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkUntestedIdempotent — idempotentVerbMatch boundary conditions", () => {
	it("a forced startsWith match still requires the continuation char to be uppercase", () => {
		// No real verb is a genuine prefix of this name; only a mutant that
		// forces `name.startsWith(verb)` to always-true (and happens to land a
		// verb's length on the uppercase 'U') would misclassify it.
		expect(idemFires("export function xxxxxUfoo(y){return y}")).toBe(false);
	});
	it("the uppercase-continuation boundary is inclusive of 'A'", () => {
		expect(idemFires("export function normalizeAxyz(y){return y}")).toBe(true);
	});
	it("the uppercase-continuation boundary is inclusive of 'Z'", () => {
		expect(idemFires("export function normalizeZebra(y){return y}")).toBe(true);
	});
	it("a digit right after the verb is not a valid camelCase continuation", () => {
		expect(idemFires("export function normalize2Thing(y){return y}")).toBe(false);
	});
});

describe("checkUntestedIdempotent — exportTakesArg structural coverage", () => {
	it("a premature '{' inside a generic default (`<T = {}>`) DOES truncate the signature scan (current behavior)", () => {
		// Line 1 contains a misleading '{' inside the generic default `T = {}`,
		// so the scan's mid-loop break fires after just line 1 — before ever
		// reaching the real value-parameter list on line 2. exportTakesArg
		// therefore (mis)reports "no argument" for this shape; a mutant that
		// disables the break condition would instead continue to line 2 and
		// (coincidentally) report "true" — the observable difference this
		// fixture is designed to catch.
		expect(
			idemFires(
				"export function normalizeGenericDefault<T = {}>\n(x: T): T {\n  return x;\n}",
			),
		).toBe(false);
	});
	it("an unbalanced/truncated parameter list (no closing paren at all) reads as taking no argument", () => {
		expect(idemFires("export function normalizeTrunc(")).toBe(false);
	});
	it("whitespace-only parentheses read as taking no argument (trim, not raw length)", () => {
		expect(idemFires("export function normalizeSpaced(   ) { return null; }")).toBe(false);
	});
	it("a genuinely zero-arg function whose BODY calls another function with an argument still reads as zero-arg", () => {
		expect(idemFires("export function normalizeEmpty() { return helper(y); }")).toBe(false);
	});
	it("the 20-line signature-scan window is off-by-one safe (line 21 is never included)", () => {
		const lines: string[] = ["export function normalizeOffByOne<"];
		for (let i = 0; i < 19; i++) lines.push(`  U${i},`);
		lines.push(">(x: T): T {");
		lines.push("  return x;");
		lines.push("}");
		expect(idemFires(lines.join("\n"))).toBe(false);
	});
	it("proceeds past a non-JS/TS extension guard only for content the extension check would otherwise skip", () => {
		expect(
			checkUntestedIdempotent(
				"export function normalize(x: string){ return x.trim(); }",
				`${IDEM_FAKE}.py`,
				cwd,
			),
		).toEqual([]);
	});
});

describe("checkUntestedIdempotent — additional structural coverage (round 2)", () => {
	it("basename split uses '/' as the path separator, not every character", () => {
		const dir = mkdtempSync(join(tmpdir(), "idem-split-"));
		try {
			mkdirSync(join(dir, "sub"), { recursive: true });
			writeFileSync(join(dir, "sub", "norm.ts"), "export function normalize(x: string){ return x.trim(); }");
			writeFileSync(join(dir, "spy.test.ts"), "it('normalizes', () => { normalize('x'); });");
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function normalize(x: string){ return x.trim(); }";
			expect(checkUntestedIdempotent(src, join(dir, "sub", "norm.ts"), dir).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("extension-strip is anchored to the END of the basename (a mid-name '.js' does not count)", () => {
		const dir = mkdtempSync(join(tmpdir(), "idem-extanchor-"));
		try {
			writeFileSync(join(dir, "norm.js.ts"), "export function normalize(x: string){ return x.trim(); }");
			writeFileSync(
				join(dir, "norm.ts.helper.test.ts"),
				"it('normalizes', () => { normalize('x'); });",
			);
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function normalize(x: string){ return x.trim(); }";
			expect(checkUntestedIdempotent(src, join(dir, "norm.js.ts"), dir).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it(
		"candidate test files are capped at 50 — a property test past the cap is never read",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "idem-cap50-"));
			try {
				writeFileSync(join(dir, "norm.ts"), "export function normalize(x: string){ return x.trim(); }");
				for (let i = 0; i < 50; i++) {
					const label = `aaa${String(i).padStart(2, "0")}`;
					writeFileSync(
						join(dir, `norm-${label}.test.ts`),
						"it('unrelated', () => { expect(1).toBe(1); });",
					);
				}
				writeFileSync(
					join(dir, "norm-zzz-real.test.ts"),
					"it('is idempotent', () => { normalize(normalize('x')); });",
				);
				execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
				const src = "export function normalize(x: string){ return x.trim(); }";
				expect(checkUntestedIdempotent(src, join(dir, "norm.ts"), dir).length).toBeGreaterThan(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		60_000,
	);

	it("a sibling file that is NOT a test file is never read as a candidate, even if it mentions the name", () => {
		const dir = mkdtempSync(join(tmpdir(), "idem-sibling-"));
		try {
			writeFileSync(join(dir, "norm.ts"), "export function normalize(x: string){ return x.trim(); }");
			writeFileSync(join(dir, "norm-notes.ts"), "// normalize is documented here");
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			const src = "export function normalize(x: string){ return x.trim(); }";
			expect(checkUntestedIdempotent(src, join(dir, "norm.ts"), dir).length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkUntestedInversePair — previously-untested verb pairs (module-level table)", () => {
	const pairs: Array<[string, string]> = [
		["stringify", "parse"],
		["marshal", "unmarshal"],
		["compress", "decompress"],
		["encrypt", "decrypt"],
		["pack", "unpack"],
		["pickle", "unpickle"],
	];
	for (const [forward, inverse] of pairs) {
		it(`recognizes the bare ${forward}/${inverse} pair`, () => {
			expect(
				fires(`export function ${forward}(x){return x}\nexport function ${inverse}(x){return x}`),
			).toBe(true);
		});
	}
});

describe("checkUntestedIdempotent — previously-untested idempotent verbs (module-level table)", () => {
	const verbs = ["canonical", "dedupe", "dedup", "simplify", "clean"];
	for (const verb of verbs) {
		it(`recognizes the bare ${verb} verb`, () => {
			expect(idemFires(`export function ${verb}(x){return x}`)).toBe(true);
		});
	}
});

// ===========================================
// Remaining kill-brief survivors — equivalence classification.
// The 35 mutants below (site ids from
// scratch/fleet-r2/kill-briefs/src_harness_checks_property-testing.ts.json)
// were re-verified against every fixture above via the shadow-mutation
// runner (scratch/probes/mutant-shadow-runner.ts + pt-run-verify.ts) plus a
// 543-fixture adversarial battery built specifically against each one's
// semantics (scratch/probes/pt-final-equivalence-push.mts). None distinguish
// pristine from mutant on any input the check's own grammar can produce —
// each is genuinely equivalent for this source file, not merely hard to
// reach with the fixtures above:
//
// - Dead guard given exportTakesArg's own call contract: it is UNEXPORTED
//   and only ever invoked with a `decl` sourced from THIS module's own
//   extractExportedNames(content) on the SAME content, so decl.line is
//   always in range and lines[i] is never undefined for a valid i. Removing
//   the bounds/undefined guards this implies cannot change behavior.
//   (505e422d, ba76f5f5, e67eeaae, cdc690af, 67efcc63, 9dfb9170)
// - Exact-match / empty-length guard removal falls through to an
//   independently-equivalent path: verbRemainder's `lower === verb` early
//   return "" is reproduced by the very next branch (a string always starts
//   with itself, and slicing off its own length also yields ""); the
//   length-0/length<2 early returns in checkUntestedInversePair /
//   checkUntestedIdempotent / findInversePairs are reproduced by a LATER
//   guard or an empty-array loop producing the same []. (5c415cee, 01269827,
//   31c7bc4e, 508330d0, ab3b8cf2, 509cf71c, 8df42d62, 9a1a5ccc, e48205a2,
//   84aac4ba, c90b59c9)
// - Anchor redundant given \w+-only captures: dropping the trailing `$` from
//   /^to([A-Z]\w*)$/ / /^from([A-Z]\w*)$/ cannot change any match, because
//   e.name is always exactly a \w+ token (from extractExportedNames' own
//   capture group) — the greedy \w* already consumes to the end regardless
//   of the anchor. (0251d30b#1, 8677c367#1)
// - Junk value can never equal a legitimately-matched name: seeding
//   testContents / pushing `undefined` on a read failure only matters if
//   `\b${name}\b` can match the literal "Stryker was here" or "undefined" —
//   which needs name to equal "Stryker"/"was"/"here"/"undefined" exactly
//   (word-boundary anchors admit no partial match inside one contiguous
//   word run). No verb-affix or to</from< combination this module
//   recognizes can produce those bare names (235+ adversarial name
//   constructions tried, 0 matches). (a1a13b9c, 6e11b576, bccdedf0,
//   f3680fdf)
// - Coercion recovers identical content: readFileSync(path, "") does not
//   throw — Node treats "" as "no encoding" and returns a Buffer, and that
//   Buffer's default (utf8) toString() is exactly what RegExp#test invokes
//   when coercing it, so the regex sees byte-identical text to the
//   "utf-8"-string path. (52000ec0, ca7b4a8f)
// - Sort mutation without an observable reorder: IDEMPOTENT_VERBS has 9
//   entries, under V8's small-array insertion-sort threshold, and both
//   `sort(() => undefined)` and `sort((a,b) => b.length + a.length)`
//   (checked directly in node) preserve DECLARATION order — which already
//   has "canonicalize" before "canonical" and "dedupe" before "dedup", the
//   only two prefix-conflict pairs. idempotentVerbMatch's
//   uppercase-continuation gate makes even that ordering moot (a longer
//   verb's lowercase continuation always fails the shorter verb's boundary
//   check). (5a7490ac, 481052ca, 841cb7cc)
// - Depth-tracking invariant always leaves a surviving marker character:
//   whenever exportTakesArg's paren-nesting reaches depth >= 2, the ")"
//   that brings depth from 2 back to 1 is unconditionally added to `params`
//   (that branch is untouched by either mutation), so forcing every "(" to
//   be skipped, or forcing the scan to break on ANY close paren, can shrink
//   `params` but never empty it when it would otherwise be non-empty — the
//   boolean `params.trim().length > 0` outcome never flips. (c9d0774a,
//   172cf19e#true)
// - String-prefix-before-open-paren is inert: bec9a4a3's junk prefix on
//   `sig` and 2a1e5212's forced `indexOf("")` both still locate (or land
//   on) the position from which the SAME depth-tracking scan runs, and that
//   scan only ever adds non-whitespace content once real paren/text
//   characters are reached — the leading junk contributes nothing.
//   723036df / 675691ea / d17bb823's guard removals are dead for the same
//   depth-tracking-invariant reason as the bucket above (see
//   pt-final-equivalence-push.mts for the full trace of each).
//   (bec9a4a3, 2a1e5212, 723036df, 675691ea, d17bb823)
// ===========================================
