import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy-wrap the neighboring modules so individual tests can both observe
// real behavior (default) and, where needed, override a return value for
// one call via mockImplementationOnce/mockReturnValueOnce.
vi.mock("./policy.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./policy.js")>();
	return {
		...actual,
		filterFindingsByScore: vi.fn(actual.filterFindingsByScore),
		decideFromFindings: vi.fn(actual.decideFromFindings),
	};
});

vi.mock("./allowlist.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./allowlist.js")>();
	return {
		...actual,
		applyAllowlist: vi.fn(actual.applyAllowlist),
	};
});

vi.mock("../taint-tracker.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../taint-tracker.js")>();
	return {
		...actual,
		ratchetSensitivity: vi.fn(actual.ratchetSensitivity),
	};
});

const { runPostToolScan } = await import("./post-scan.js");
const { filterFindingsByScore, decideFromFindings } = await import("./policy.js");
const { applyAllowlist } = await import("./allowlist.js");
const { ratchetSensitivity } = await import("../taint-tracker.js");

// These mutation fixtures stay deliberately loose-typed so each case can vary one field.
function makeCfg(overrides: Record<string, any> = {}): any {
	return {
		enabled: true,
		runtime: "local",
		scan_points: {
			write_edit: false,
			bash_command: false,
			external_egress: false,
			read_grep_taint: true,
			user_prompt: false,
		},
		local: {
			python_bin: "python3",
			sidecar_script: "",
			startup_timeout_ms: 45000,
			scan_timeout_ms: 1500,
			idle_shutdown_ms: 1800000,
			max_restarts: 3,
		},
		huggingface: { model: "x", api_key_env: "HF_TOKEN", timeout_ms: 4000 },
		custom_http: { endpoint: "", timeout_ms: 4000 },
		min_score: 0,
		max_scan_bytes: 0,
		...overrides,
	};
}

// These mutation fixtures stay deliberately loose-typed so each case can vary one field.
function makeRules(overrides: Record<string, any> = {}): any {
	return {
		content_scanner: makeCfg(overrides.content_scanner ?? {}),
		output_scanning: overrides.output_scanning,
		taint_tracking: overrides.taint_tracking,
	};
}

// These mutation fixtures stay deliberately loose-typed so each case can vary one field.
function makeEvent(overrides: Record<string, any> = {}): any {
	return {
		hook_event: "PostToolUse",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-01-01T00:00:00Z",
		tool_name: "Read",
		tool_response: "hello world",
		tool_input: {},
		...overrides,
	};
}

// These mutation fixtures stay deliberately loose-typed so each case can vary one field.
function makeSession(overrides: Record<string, any> = {}): any {
	return {
		pii_detected_steps: [],
		tool_call_count: 3,
		...overrides,
	};
}

function makeScanner(findings: unknown[] = []) {
	return {
		name: "fake",
		runtime: "local",
		ready: async () => true,
		// The request stays loose because each case asserts the relevant request shape.
		scan: vi.fn(async (_req: any) => findings),
		shutdown: async () => {},
	};
}

const ONE_FINDING = [{ label: "secret", start: 0, end: 5, text: "hello", score: 1, source: "x" }];

beforeEach(() => {
	vi.mocked(filterFindingsByScore).mockClear();
	vi.mocked(decideFromFindings).mockClear();
	vi.mocked(applyAllowlist).mockClear();
	vi.mocked(ratchetSensitivity).mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPostToolScan — mutation kill w58", () => {
	it("passes the raw string response to the scanner, not a JSON-stringified copy", async () => {
		const scanner = makeScanner([]);
		const event = makeEvent({ tool_response: "hi" });
		await runPostToolScan({
			event,
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(scanner.scan).toHaveBeenCalledTimes(1);
		const call = scanner.scan.mock.calls[0]?.[0] as { text: string };
		expect(call.text).toBe("hi");
	});

	it("does not touch JSON.stringify when tool_response is undefined (short-circuits early)", async () => {
		const stringifySpy = vi.spyOn(JSON, "stringify");
		const scanner = makeScanner([]);
		const event = makeEvent({ tool_response: undefined });
		const result = await runPostToolScan({
			event,
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(stringifySpy).not.toHaveBeenCalled();
		expect(result).toEqual({ warnings: [], findings: [] });
		expect(scanner.scan).not.toHaveBeenCalled();
	});

	it("never reads rules.content_scanner when no scanner is configured", async () => {
		const rules = makeRules();
		let getCount = 0;
		Object.defineProperty(rules, "content_scanner", {
			get() {
				getCount++;
				return makeCfg();
			},
		});
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules,
			scanner: undefined,
			compiledAllowlist: [],
		});
		expect(getCount).toBe(0);
		expect(result).toEqual({ warnings: [], findings: [] });
	});

	it("resolves to an empty result (does not throw) when content_scanner config is absent", async () => {
		const rules = makeRules({ content_scanner: undefined });
		delete (rules as any).content_scanner;
		const scanner = makeScanner([]);
		await expect(
			runPostToolScan({
				event: makeEvent(),
				session: undefined,
				rules,
				scanner: scanner as any,
				compiledAllowlist: [],
			}),
		).resolves.toEqual({ warnings: [], findings: [] });
	});

	it("checks READ_TOOLS membership using the empty-string default, not a placeholder", async () => {
		const hasSpy = vi.spyOn(Set.prototype, "has");
		const scanner = makeScanner([]);
		const event = makeEvent({ tool_name: undefined });
		const result = await runPostToolScan({
			event,
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		const relevantCalls = hasSpy.mock.calls.filter(
			(c) => c[0] === "" || c[0] === "Stryker was here!",
		);
		expect(relevantCalls).toEqual([[""]]);
		expect(result).toEqual({ warnings: [], findings: [] });
	});

	it("falls back to DEFAULT_MAX_SCAN_BYTES (no throw) when output_scanning is absent", async () => {
		const rules = makeRules({ content_scanner: { max_scan_bytes: 0 }, output_scanning: undefined });
		const scanner = makeScanner([]);
		await expect(
			runPostToolScan({
				event: makeEvent(),
				session: undefined,
				rules,
				scanner: scanner as any,
				compiledAllowlist: [],
			}),
		).resolves.toEqual({ warnings: [], findings: [] });
		expect(scanner.scan).toHaveBeenCalledTimes(1);
	});

	it("passes '<toolName>.tool_response' as the scan source", async () => {
		const scanner = makeScanner([]);
		const event = makeEvent({ tool_name: "Read", tool_response: "hello" });
		await runPostToolScan({
			event,
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		const call = scanner.scan.mock.calls[0]?.[0] as { source: string };
		expect(call.source).toBe("Read.tool_response");
	});

	it("skips score filtering entirely when the scanner reports zero findings", async () => {
		const scanner = makeScanner([]);
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(filterFindingsByScore).not.toHaveBeenCalled();
		expect(result).toEqual({ warnings: [], findings: [] });
	});

	it("falls back to the default scan timeout when scan_timeout_ms is 0", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const scanner = makeScanner([]);
		const rules = makeRules({ content_scanner: { local: { ...makeCfg().local, scan_timeout_ms: 0 } } });
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules,
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(timeoutSpy).toHaveBeenCalledWith(1500);
		expect(result).toEqual({ warnings: [], findings: [] });
	});

	it("skips allowlist filtering when nothing clears the score floor", async () => {
		const scanner = makeScanner(ONE_FINDING.map((f) => ({ ...f, score: 0 })));
		const rules = makeRules({ content_scanner: { min_score: 1 } });
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules,
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(applyAllowlist).not.toHaveBeenCalled();
		expect(result).toEqual({ warnings: [], findings: [] });
	});

	it("falls back to '<toolName>-response>' placeholder path when tool_input.file_path is absent", async () => {
		const scanner = makeScanner(ONE_FINDING);
		const session = makeSession();
		const rules = makeRules({ taint_tracking: { enabled: true } });
		const event = makeEvent({ tool_name: "Read", tool_input: {} });
		await runPostToolScan({
			event,
			session,
			rules,
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(ratchetSensitivity).toHaveBeenCalledTimes(1);
		const filePathArg = vi.mocked(ratchetSensitivity).mock.calls[0]?.[1];
		expect(filePathArg).toBe("<Read-response>");
	});

	it("does not touch the session when session is undefined, even with findings present", async () => {
		const scanner = makeScanner(ONE_FINDING);
		const rules = makeRules({ taint_tracking: { enabled: true } });
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules,
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(result.ratcheted_to).toBeUndefined();
		expect(ratchetSensitivity).not.toHaveBeenCalled();
	});

	it("does not throw when session exists but taint_tracking config is absent", async () => {
		const scanner = makeScanner(ONE_FINDING);
		const session = makeSession();
		const rules = makeRules({ taint_tracking: undefined });
		const result = await runPostToolScan({
			event: makeEvent(),
			session,
			rules,
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(result.ratcheted_to).toBeUndefined();
		expect(ratchetSensitivity).not.toHaveBeenCalled();
	});

	it("includes the tool name and sensitivity level in the emitted warning", async () => {
		const scanner = makeScanner(ONE_FINDING);
		const result = await runPostToolScan({
			event: makeEvent({ tool_name: "Grep" }),
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(result.warnings[0]).toMatch(/^\[interlinked:content-scanner\] Grep returned sensitive content /);
	});

	it("does not set ratcheted_to when ratchetSensitivity reports no change", async () => {
		vi.mocked(ratchetSensitivity).mockReturnValueOnce(false);
		const scanner = makeScanner(ONE_FINDING);
		const session = makeSession();
		const rules = makeRules({ taint_tracking: { enabled: true } });
		const result = await runPostToolScan({
			event: makeEvent(),
			session,
			rules,
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(result.ratcheted_to).toBeUndefined();
		expect(session.pii_detected_steps).toEqual([session.tool_call_count]);
	});

	it("removes only the anchored BLOCKED prefix, not a later occurrence mid-string", async () => {
		vi.mocked(decideFromFindings).mockReturnValueOnce({
			decision: "ask",
			reason: "xxx BLOCKED: yyy",
		});
		const scanner = makeScanner(ONE_FINDING);
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(result.warnings[0]).toContain("xxx BLOCKED: yyy");
	});

	it("replaces the anchored BLOCKED prefix with an empty string, not a placeholder", async () => {
		vi.mocked(decideFromFindings).mockReturnValueOnce({
			decision: "ask",
			reason: "BLOCKED: hello",
		});
		const scanner = makeScanner(ONE_FINDING);
		const result = await runPostToolScan({
			event: makeEvent(),
			session: undefined,
			rules: makeRules(),
			scanner: scanner as any,
			compiledAllowlist: [],
		});
		expect(result.warnings[0]).toContain("). hello");
		expect(result.warnings[0]).not.toContain("Stryker was here!");
	});
});
