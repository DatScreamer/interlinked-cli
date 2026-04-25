// Regression tests for the security/info-flow rules in builtin-rules-security.ts.
// Focused on the scanner-pending-access rule because that one is load-bearing
// for the privacy-filter design — if it regresses, raw PII can flow back into
// the agent's context via Bash/Grep/Glob, defeating the systemMessage channel.

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../default-config.js";
import { SECURITY_AND_SAFETY_RULES } from "../builtin-rules-security.js";

const PENDING_ACCESS_RULE_ID = "builtin-scanner-pending-access";
const PENDING_GLOB = ".interlinked/scanner/pending/**";
const AUDIT_GLOB = ".interlinked/content-scanner.audit.jsonl";

function findRule(id: string) {
	return SECURITY_AND_SAFETY_RULES.find((r) => r.id === id);
}

function patternMatches(rule: NonNullable<ReturnType<typeof findRule>>, field: string, input: string): boolean {
	for (const p of rule.patterns) {
		if (p.field !== field) continue;
		const flags = p.flags ?? "i";
		const re = new RegExp(p.regex, flags);
		const hit = re.test(input);
		if (p.negate) {
			if (hit) return false;
		} else if (hit) {
			return true;
		}
	}
	return false;
}

describe("builtin-scanner-pending-access — rule shape", () => {
	it("is registered in SECURITY_AND_SAFETY_RULES", () => {
		expect(findRule(PENDING_ACCESS_RULE_ID)).toBeDefined();
	});

	it("blocks (not warns) — these files leak raw PII", () => {
		expect(findRule(PENDING_ACCESS_RULE_ID)?.action).toBe("block");
	});

	it("is critical severity — same tier as supply-chain rules", () => {
		expect(findRule(PENDING_ACCESS_RULE_ID)?.severity).toBe("critical");
	});

	it("matches the broad set of path-traffic tools (Bash, Grep, Glob, Search)", () => {
		const rule = findRule(PENDING_ACCESS_RULE_ID);
		expect(rule?.tool_match).toEqual(
			expect.arrayContaining(["Bash", "Shell", "run_command", "Grep", "Glob"]),
		);
	});
});

describe("builtin-scanner-pending-access — Bash command body", () => {
	const rule = findRule(PENDING_ACCESS_RULE_ID);
	if (!rule) throw new Error("rule missing — earlier shape test should have caught this");

	it.each([
		["cat .interlinked/scanner/pending/2026-04-25T17-39-06-126Z-foo.json"],
		["less .interlinked/scanner/pending/recent.json"],
		["head -n 50 .interlinked/scanner/pending/foo.json"],
		["tail .interlinked/scanner/pending/foo.json"],
		["grep -r email .interlinked/scanner/pending/"],
		["rg secret .interlinked/scanner/pending"],
		["jq . .interlinked/scanner/pending/foo.json"],
		["find .interlinked/scanner/pending -name '*.json'"],
		["ls -la .interlinked/scanner/pending/"],
		["xxd .interlinked/scanner/pending/foo.json | head"],
		// Audit log paths
		["cat .interlinked/content-scanner.audit.jsonl"],
		["tail -f .interlinked/content-scanner.audit.jsonl"],
	])("blocks: %s", (cmd) => {
		expect(patternMatches(rule, "command", cmd)).toBe(true);
	});

	it.each([
		// Other .interlinked paths the agent IS allowed to look at — must NOT match.
		["cat .interlinked/guard-rules.json"],
		["ls .interlinked/sessions/"],
		["cat .interlinked/activity.jsonl"],
		// Repo paths that mention "scanner" but not the pending folder.
		["cat src/harness/content-scanner/types.ts"],
		["grep pending src/harness/content-scanner/"],
		// Innocuous commands.
		["echo hello"],
		["npm test"],
	])("does NOT block: %s", (cmd) => {
		expect(patternMatches(rule, "command", cmd)).toBe(false);
	});
});

describe("builtin-scanner-pending-access — Grep path field", () => {
	const rule = findRule(PENDING_ACCESS_RULE_ID);
	if (!rule) throw new Error("rule missing");

	it("blocks Grep on the pending folder", () => {
		expect(patternMatches(rule, "path", ".interlinked/scanner/pending")).toBe(true);
	});

	it("blocks Grep on the audit log", () => {
		expect(patternMatches(rule, "path", ".interlinked/content-scanner.audit.jsonl")).toBe(true);
	});

	it("does NOT block Grep on src/", () => {
		expect(patternMatches(rule, "path", "src/harness/content-scanner")).toBe(false);
	});
});

describe("builtin-scanner-pending-access — Glob pattern field", () => {
	const rule = findRule(PENDING_ACCESS_RULE_ID);
	if (!rule) throw new Error("rule missing");

	it("blocks Glob targeting the pending folder", () => {
		expect(patternMatches(rule, "pattern", ".interlinked/scanner/pending/**/*.json")).toBe(true);
	});

	it("blocks Glob targeting the audit log path", () => {
		expect(patternMatches(rule, "pattern", "**/.interlinked/content-scanner.audit.jsonl")).toBe(
			true,
		);
	});

	it("does NOT block Glob on a typical source-tree pattern", () => {
		expect(patternMatches(rule, "pattern", "src/**/*.ts")).toBe(false);
	});
});

describe("protected_files coverage for scanner-local artifacts", () => {
	// Belt-and-suspenders: even if the dynamic rule above is somehow disabled,
	// the protected_files static list catches the canonical Read/Write/Edit
	// case via a separate fast path in evaluateProtectedFiles().
	it("covers .interlinked/scanner/pending/** for Read/Write/Edit", () => {
		const entry = DEFAULT_CONFIG.protected_files.find((p) => p.glob === PENDING_GLOB);
		expect(entry).toBeDefined();
		expect(entry?.operations).toEqual(
			expect.arrayContaining(["Read", "Write", "Edit", "Delete"]),
		);
	});

	it("covers .interlinked/content-scanner.audit.jsonl for Read/Write/Edit", () => {
		const entry = DEFAULT_CONFIG.protected_files.find((p) => p.glob === AUDIT_GLOB);
		expect(entry).toBeDefined();
		expect(entry?.operations).toEqual(
			expect.arrayContaining(["Read", "Write", "Edit", "Delete"]),
		);
	});
});
