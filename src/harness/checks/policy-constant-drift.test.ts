import { describe, expect, it } from "vitest";
import { detectPolicyConstantDrift } from "./policy-constant-drift.js";

const FILE = "src/lib/config.ts";

// ---------------------------------------------------------------------------
// Positive cases — MUST fire
// ---------------------------------------------------------------------------

describe("detectPolicyConstantDrift — positive cases (must fire)", () => {
	it("fires when MAX_RETRIES=7 and bare 7 used in a conditional", () => {
		const content = `
const MAX_RETRIES = 7;

function runWithRetry(fn: () => void): void {
  let attempts = 0;
  while (attempts < 7) {
    fn();
    attempts++;
  }
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].text).toMatch(/MAX_RETRIES/);
		expect(findings[0].line).toBeGreaterThan(1);
	});

	it("fires when DEFAULT_TIMEOUT_MS=4500 and bare 4500 used in setTimeout", () => {
		const content = `
export const DEFAULT_TIMEOUT_MS = 4500;

function scheduleCleanup(fn: () => void): void {
  setTimeout(fn, 4500);
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].text).toMatch(/DEFAULT_TIMEOUT_MS/);
	});

	it("fires when CYCLOMATIC_CAP=25 and bare 25 used in a guard", () => {
		const content = `
const CYCLOMATIC_CAP = 25;

function isTooComplex(score: number): boolean {
  return score > 25;
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].text).toMatch(/CYCLOMATIC_CAP/);
	});

	it("fires for a _THRESHOLD suffix constant", () => {
		const content = `
const MEMORY_THRESHOLD = 512;

export function isOverLimit(mb: number): boolean {
  if (mb > 512) {
    throw new Error("too much");
  }
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBeGreaterThan(0);
	});

	it("fires for a DEFAULT_ prefixed constant with assignment", () => {
		const content = `
export const DEFAULT_PAGE_SIZE = 50;

function paginate(items: string[]): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < items.length; i += 50) {
    pages.push(items.slice(i, i + 50));
  }
  return pages;
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		// Should fire for each of the two bare `50` usages
		expect(findings.length).toBeGreaterThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// Negative cases — MUST NOT fire
// ---------------------------------------------------------------------------

describe("detectPolicyConstantDrift — negative cases (must NOT fire)", () => {
	it("does NOT fire when the code references the constant by name", () => {
		const content = `
const MAX_RETRIES = 7;

function runWithRetry(fn: () => void): void {
  let attempts = 0;
  while (attempts < MAX_RETRIES) {
    fn();
    attempts++;
  }
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});

	it("does NOT fire for trivial number 1 even if named policy constant", () => {
		// 1 is in the trivial-number exclusion list
		const content = `
const MAX_ATTEMPTS = 1;

function runOnce(fn: () => void): void {
  for (let i = 0; i < 1; i++) {
    fn();
  }
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});

	it("does NOT fire when the bare literal only appears inside a comment", () => {
		const content = `
const CYCLOMATIC_CAP = 25;

// was 25 before we lowered it — now using the constant
function check(n: number): boolean {
  return n > CYCLOMATIC_CAP;
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});

	it("does NOT fire when the bare literal only appears inside a string", () => {
		const content = `
const MAX_RETRIES = 7;

function describe(): string {
  return "retry up to 7 times as a doc string";
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});

	it("does NOT fire when file has a policy constant but no duplicate literal", () => {
		const content = `
export const DEFAULT_BATCH_SIZE = 200;

export function process(items: string[]): void {
  const chunks = chunk(items, DEFAULT_BATCH_SIZE);
  chunks.forEach(run);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});

	it("does NOT fire for trivial number 100 even if named policy constant", () => {
		// 100 is in the exclusion list (common percentage / fallback sentinel)
		const content = `
const DEFAULT_PERCENTAGE = 100;

function isComplete(pct: number): boolean {
  return pct >= 100;
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});

	it("does NOT fire in test files (isTestFile guard)", () => {
		const content = `
const MAX_RETRIES = 7;
expect(retries).toBe(7);
`.trim();
		// .test.ts path should be exempted
		const findings = detectPolicyConstantDrift(content, "src/lib/config.test.ts");
		expect(findings.length).toBe(0);
	});

	it("does NOT match a larger number containing the literal (no partial match)", () => {
		const content = `
const MAX_RETRIES = 7;

function foo(): void {
  const x = 70; // 70 is NOT 7
  const y = 17; // 17 is NOT 7
}
`.trim();
		const findings = detectPolicyConstantDrift(content, FILE);
		expect(findings.length).toBe(0);
	});
});
