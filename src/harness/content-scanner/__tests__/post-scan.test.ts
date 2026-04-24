import { describe, expect, it, vi } from "vitest";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../../types.js";
import { runPostToolScan } from "../post-scan.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "../types.js";

// ===========================================
// Fixtures
// ===========================================

function makeScannerConfig(overrides: Partial<ContentScannerConfig> = {}): ContentScannerConfig {
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
			sidecar_script: "/tmp/opf.py",
			startup_timeout_ms: 45_000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1_800_000,
			max_restarts: 3,
		},
		huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 100_000,
		...overrides,
	};
}

function makeRules(scanner: ContentScannerConfig | undefined): GuardRulesConfig {
	return {
		version: 1,
		enabled: true,
		rules: [],
		protected_files: [],
		file_reminders: [],
		curl_mcp_detection: { enabled: false, localhost_ports: [], escalate_after: 0, message: "" },
		quality_checks: {} as GuardRulesConfig["quality_checks"],
		error_memory: { enabled: false, max_age_s: 0, max_records: 0 },
		taint_tracking: {
			enabled: true,
			file_sensitivity: [],
			step_limits: {
				Public: Number.POSITIVE_INFINITY,
				Internal: 1000,
				Confidential: 500,
				HighlyConfidential: 100,
			},
			network_block_at: "Confidential",
		},
		output_scanning: {
			enabled: true,
			scan_bash_secrets: false,
			scan_web_injection: false,
			scan_file_injection: false,
			max_scan_bytes: 100_000,
		},
		structural_checks: {} as GuardRulesConfig["structural_checks"],
		repo_confinement_allowlist: [],
		required_tools: [],
		strict_skips: false,
		skip_allowlist: [],
		project_wide_checks: {} as GuardRulesConfig["project_wide_checks"],
		content_scanner: scanner,
	};
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "s",
		agent_name: "agent",
		started_at: "2026-04-24T00:00:00Z",
		tool_call_count: 5,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
	};
}

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		agent_name: "agent",
		tool_name: "Read",
		tool_input: { file_path: "/x.txt" },
		tool_response: "",
		timestamp: "2026-04-24T00:00:00Z",
		...overrides,
	};
}

function makeScanner(findings: ScanFinding[]): ContentScanner {
	return {
		name: "stub",
		runtime: "local",
		ready: async () => true,
		scan: vi.fn(async (_req) => findings),
		shutdown: async () => {},
	};
}

// ===========================================
// Tests
// ===========================================

describe("runPostToolScan — applicability", () => {
	it("returns empty when scanner is undefined", async () => {
		const r = await runPostToolScan(makeEvent(), makeSession(), makeRules(makeScannerConfig()), undefined);
		expect(r.warnings).toEqual([]);
		expect(r.findings).toEqual([]);
	});

	it("returns empty when content_scanner is disabled", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan(
			makeEvent({ tool_response: "x" }),
			makeSession(),
			makeRules(makeScannerConfig({ enabled: false })),
			scanner,
		);
		expect(r.findings).toEqual([]);
	});

	it("returns empty when read_grep_taint scan point is off", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const cfg = makeScannerConfig();
		cfg.scan_points.read_grep_taint = false;
		const r = await runPostToolScan(makeEvent({ tool_response: "x" }), makeSession(), makeRules(cfg), scanner);
		expect(r.findings).toEqual([]);
	});

	it("returns empty for non-Read tool names", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan(
			makeEvent({ tool_name: "Write", tool_response: "secret" }),
			makeSession(),
			makeRules(makeScannerConfig()),
			scanner,
		);
		expect(r.findings).toEqual([]);
	});

	it("returns empty when tool_response is empty", async () => {
		const scanner = makeScanner([{ label: "secret", start: 0, end: 1, text: "x", source: "" }]);
		const r = await runPostToolScan(
			makeEvent({ tool_response: "" }),
			makeSession(),
			makeRules(makeScannerConfig()),
			scanner,
		);
		expect(r.findings).toEqual([]);
	});
});

describe("runPostToolScan — taint ratchet + warnings", () => {
	it("ratchets to Confidential and warns when non-critical PII is detected", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
		]);
		const r = await runPostToolScan(
			makeEvent({ tool_response: "email: a@b.com" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);

		expect(session.sensitivity_level).toBe("Confidential");
		expect(session.pii_detected_steps).toContain(5);
		expect(r.ratcheted_to).toBe("Confidential");
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("Confidential");
		expect(r.warnings[0]).toContain("private_email(1)");
	});

	it("does not ratchet or warn when all findings are below min_score", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{
				label: "private_email",
				start: 0,
				end: 7,
				text: "a@b.com",
				score: 0.4,
				source: "",
			},
		]);
		const r = await runPostToolScan(
			makeEvent({ tool_response: "email: a@b.com" }),
			session,
			makeRules(makeScannerConfig({ min_score: 0.9 })),
			scanner,
		);

		expect(r.findings).toEqual([]);
		expect(r.warnings).toEqual([]);
		expect(r.ratcheted_to).toBeUndefined();
		expect(session.sensitivity_level).toBe("Public");
		expect(session.pii_detected_steps).toEqual([]);
	});

	it("ratchets to HighlyConfidential when a secret is present", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
			{ label: "secret", start: 10, end: 22, text: "sk_live_abc", source: "" },
		]);
		const r = await runPostToolScan(
			makeEvent({ tool_response: "a@b.com sk_live_abc" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);

		expect(session.sensitivity_level).toBe("HighlyConfidential");
		expect(r.ratcheted_to).toBe("HighlyConfidential");
		expect(r.warnings[0]).toContain("HighlyConfidential");
		expect(r.warnings[0]).toContain("private_email(1), secret(1)");
	});

	it("ratchets to HighlyConfidential when only an account_number is present", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "account_number", start: 0, end: 9, text: "021000021", source: "" },
		]);
		await runPostToolScan(
			makeEvent({ tool_response: "routing 021000021" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});

	it("pushes the tool-call step to pii_detected_steps even when the ratchet is a no-op", async () => {
		const session = makeSession();
		session.sensitivity_level = "HighlyConfidential"; // already at top
		const scanner = makeScanner([
			{ label: "private_email", start: 0, end: 7, text: "a@b.com", source: "" },
		]);
		await runPostToolScan(
			makeEvent({ tool_response: "a@b.com" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);
		// Sensitivity stays at the existing top level...
		expect(session.sensitivity_level).toBe("HighlyConfidential");
		// ...but we still record detection so PreToolUse gating can fire.
		expect(session.pii_detected_steps).toContain(5);
	});

	it("fails open when the scanner throws (no warning, no ratchet)", async () => {
		const session = makeSession();
		const scanner: ContentScanner = {
			name: "broken",
			runtime: "local",
			ready: async () => true,
			scan: async () => {
				throw new Error("boom");
			},
			shutdown: async () => {},
		};
		const r = await runPostToolScan(
			makeEvent({ tool_response: "secret" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);
		expect(r.warnings).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
		expect(session.pii_detected_steps).toEqual([]);
	});

	it("no warning when the scanner returns no findings", async () => {
		const session = makeSession();
		const scanner = makeScanner([]);
		const r = await runPostToolScan(
			makeEvent({ tool_response: "hello world" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);
		expect(r.warnings).toEqual([]);
		expect(session.sensitivity_level).toBe("Public");
	});

	it("respects max_scan_bytes by truncating before calling the scanner", async () => {
		const session = makeSession();
		const big = "x".repeat(200_000);
		const scanner = makeScanner([]);
		const cfg = makeScannerConfig();
		cfg.max_scan_bytes = 50_000;
		await runPostToolScan(makeEvent({ tool_response: big }), session, makeRules(cfg), scanner);
		const scanSpy = scanner.scan as unknown as ReturnType<typeof vi.fn>;
		expect(scanSpy.mock.calls[0][0].text.length).toBe(50_000);
	});

	it("scans Grep tool results (not just Read)", async () => {
		const session = makeSession();
		const scanner = makeScanner([
			{ label: "secret", start: 0, end: 3, text: "sk_", source: "" },
		]);
		const r = await runPostToolScan(
			makeEvent({ tool_name: "Grep", tool_response: "line 1: sk_live_abc" }),
			session,
			makeRules(makeScannerConfig()),
			scanner,
		);
		expect(r.findings).toHaveLength(1);
	});
});
