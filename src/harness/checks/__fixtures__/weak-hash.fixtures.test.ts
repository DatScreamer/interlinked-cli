// Canonical-examples fixture for `ubs_weak_hash` (`checkWeakHash`).
//
// Each row is a real-world shape the detector should classify. New variants
// surfaced in PR review (e.g. `crypto.createHash("md5")` — Node's primary
// weak-hash API which the original regex missed) land as new rows here.

import { describe } from "vitest";
import { checkWeakHash } from "../agent-safety.js";
import { type FixtureRow, runDetectorFixtures } from "./run-fixtures.js";

const FIXTURES: FixtureRow[] = [
	// --- Should fire ---
	{
		input: 'const h = crypto.createHash("md5").update(buf).digest();',
		filePath: "src/auth.ts",
		shouldFire: true,
		note: 'Node `crypto.createHash("md5")` (the variant a 2025 reviewer surfaced)',
	},
	{
		input: 'const h = crypto.createHash("sha1");',
		filePath: "src/auth.ts",
		shouldFire: true,
		note: 'Node `createHash("sha1")` with double quotes',
	},
	{
		input: "const h = createHash('sha1');",
		filePath: "src/auth.ts",
		shouldFire: true,
		note: "Node `createHash('sha1')` with single quotes",
	},
	{
		input: "const h = createHash(`md5`);",
		filePath: "src/auth.ts",
		shouldFire: true,
		note: "Node `createHash(`md5`)` with template literal",
	},
	{
		input: "const digest = md5(buffer);",
		filePath: "src/auth.ts",
		shouldFire: true,
		note: "JS short form `md5(buf)`",
	},
	{
		input: "h = hashlib.md5(data).hexdigest()",
		filePath: "src/auth.py",
		shouldFire: true,
		note: "Python `hashlib.md5(...)`",
	},
	{
		input: "fingerprint = SHA1(payload)",
		filePath: "src/sig.ts",
		shouldFire: true,
		note: "case-insensitive: `SHA1(`",
	},
	// --- Should NOT fire ---
	{
		input: 'const h = crypto.createHash("sha256");',
		filePath: "src/auth.ts",
		shouldFire: false,
		note: 'acceptable: `createHash("sha256")`',
	},
	{
		input: "const h = sha256(buf);",
		filePath: "src/auth.ts",
		shouldFire: false,
		note: "acceptable short form: `sha256(buf)`",
	},
	{
		input: "const sha1234 = somethingElse(x);",
		filePath: "src/auth.ts",
		shouldFire: false,
		note: "boundary FP: identifier `sha1234` is not `sha1(`",
	},
	{
		input: '// don\'t use md5(payload)',
		filePath: "src/auth.ts",
		shouldFire: false,
		note: "comment: `// don't use md5(`",
	},
	{
		input: '// example only: createHash("md5")',
		filePath: "src/auth.ts",
		shouldFire: false,
		note: 'comment with createHash literal',
	},
	{
		input: 'const msg = "use sha256, not md5(";',
		filePath: "src/auth.ts",
		shouldFire: false,
		note: "string literal mentioning the algorithm name (no createHash wrapper)",
	},
	{
		input: "expect(md5(buf)).toBe('5d41402abc4b2a76b9719d911017c592');",
		filePath: "src/auth.test.ts",
		shouldFire: false,
		note: "test files: golden hash fixtures are routine",
	},
];

describe("ubs_weak_hash fixtures (canonical examples)", () => {
	runDetectorFixtures(checkWeakHash, FIXTURES);
});
