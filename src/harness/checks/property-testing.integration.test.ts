import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
});
