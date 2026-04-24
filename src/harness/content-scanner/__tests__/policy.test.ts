import { describe, expect, it } from "vitest";
import { decideFromFindings } from "../policy.js";
import { OPF_LABELS } from "../types.js";
import type { ContentScannerConfig, ScanFinding } from "../types.js";

function makeConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: true,
			bash_command: true,
			external_egress: true,
			read_grep_taint: true,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "/tmp/opf-sidecar.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: {
			model: "openai/gpt-oss-safeguard-20b",
			api_key_env: "HF_TOKEN",
			timeout_ms: 4000,
		},
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function finding(label: string, text: string, score?: number): ScanFinding {
	return { label, start: 0, end: text.length, text, score, source: "Test.field" };
}

describe("decideFromFindings", () => {
	it("allows when there are no findings", () => {
		const verdict = decideFromFindings([], makeConfig());
		expect(verdict.decision).toBe("allow");
		expect(verdict.reason).toBeUndefined();
	});

	it("blocks on a single finding and lists the category with count", () => {
		const verdict = decideFromFindings([finding("secret", "sk_live_abc")], makeConfig());
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain("[secret(1)]");
	});

	it("allows when all findings are below min_score", () => {
		const verdict = decideFromFindings(
			[finding("private_email", "a@b.com", 0.3)],
			makeConfig({ min_score: 0.8 }),
		);
		expect(verdict.decision).toBe("allow");
	});

	it("blocks when one finding is above and one below min_score — reason enumerates only above", () => {
		const verdict = decideFromFindings(
			[finding("private_email", "a@b.com", 0.9), finding("private_person", "Alice", 0.2)],
			makeConfig({ min_score: 0.5 }),
		);
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain("[private_email(1)]");
		expect(verdict.reason).not.toContain("private_person");
	});

	it("groups multi-category findings alphabetically with per-category counts", () => {
		const findings = [
			finding("private_email", "a@b.com"),
			finding("private_email", "c@d.com"),
			finding("secret", "sk_live_xxx"),
			finding("account_number", "021000021"),
		];
		const verdict = decideFromFindings(findings, makeConfig());
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain("[account_number(1), private_email(2), secret(1)]");
	});

	it("enumerates all 8 labels alphabetically when every category is present", () => {
		const findings = OPF_LABELS.map((label) => finding(label, "x"));
		const verdict = decideFromFindings(findings, makeConfig());
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain(
			"[account_number(1), private_address(1), private_date(1), private_email(1), " +
				"private_person(1), private_phone(1), private_url(1), secret(1)]",
		);
	});

	it("passes unknown future labels through unchanged (forward compatibility)", () => {
		const verdict = decideFromFindings(
			[finding("future_label", "xx"), finding("secret", "yy")],
			makeConfig(),
		);
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).toContain("[future_label(1), secret(1)]");
	});

	it("never echoes matched substrings in the block reason (no content leakage)", () => {
		const pii = "super_unique_secret_token_XYZ_abc123";
		const alice = "Alice Jones";
		const verdict = decideFromFindings(
			[
				finding("secret", pii),
				finding("private_person", alice),
				finding("private_email", "alice@example.com"),
			],
			makeConfig(),
		);
		expect(verdict.decision).toBe("ask");
		expect(verdict.reason).not.toContain(pii);
		expect(verdict.reason).not.toContain(alice);
		expect(verdict.reason).not.toContain("alice@example.com");
	});

	it("treats finding.score = undefined as 1.0 (OPF local emits no score)", () => {
		const verdict = decideFromFindings(
			[finding("private_email", "a@b.com", undefined)],
			makeConfig({ min_score: 0.9 }),
		);
		expect(verdict.decision).toBe("ask");
	});
});

describe("OPF_LABELS taxonomy", () => {
	it("contains exactly the 8 OPF categories", () => {
		expect(OPF_LABELS).toHaveLength(8);
	});

	it("is stored in alphabetical order (matches sort used by decideFromFindings)", () => {
		const sorted = [...OPF_LABELS].sort((a, b) => a.localeCompare(b));
		expect([...OPF_LABELS]).toEqual(sorted);
	});

	it("contains the canonical labels from the OPF model card", () => {
		// Pinned list — bump atomically if the model adds categories.
		expect([...OPF_LABELS]).toEqual([
			"account_number",
			"private_address",
			"private_date",
			"private_email",
			"private_person",
			"private_phone",
			"private_url",
			"secret",
		]);
	});
});
