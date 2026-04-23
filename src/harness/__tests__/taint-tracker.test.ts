import { describe, expect, it } from "vitest";
import {
	classifyFileSensitivity,
	DEFAULT_TAINT_CONFIG,
	isNetworkCommand,
	isStepLimitExceeded,
	ratchetSensitivity,
	SENSITIVITY_ORDER,
	shouldBlockNetwork,
} from "../taint-tracker.js";
import type { SessionTrajectory } from "../types.js";

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(): SessionTrajectory {
	return {
		session_id: "test",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
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
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
	};
}

describe("classifyFileSensitivity", () => {
	const config = DEFAULT_TAINT_CONFIG;

	it("classifies .pem files as HighlyConfidential", () => {
		expect(classifyFileSensitivity("/path/to/cert.pem", config)).toBe("HighlyConfidential");
	});

	it("classifies SSH keys as HighlyConfidential", () => {
		expect(classifyFileSensitivity("/home/user/.ssh/id_rsa", config)).toBe(
			"HighlyConfidential",
		);
		expect(classifyFileSensitivity("/home/user/.ssh/id_ed25519", config)).toBe(
			"HighlyConfidential",
		);
	});

	it("classifies AWS credentials as HighlyConfidential", () => {
		expect(classifyFileSensitivity("/home/user/.aws/credentials", config)).toBe(
			"HighlyConfidential",
		);
	});

	it("classifies .env files as Confidential", () => {
		expect(classifyFileSensitivity("/project/.env", config)).toBe("Confidential");
		expect(classifyFileSensitivity("/project/.env.production", config)).toBe("Confidential");
	});

	it("classifies interlinked local config as Internal", () => {
		expect(classifyFileSensitivity("/project/.interlinked/config.local.json", config)).toBe(
			"Internal",
		);
	});

	it("classifies normal source files as Public", () => {
		expect(classifyFileSensitivity("/project/src/index.ts", config)).toBe("Public");
		expect(classifyFileSensitivity("/project/README.md", config)).toBe("Public");
	});
});

describe("ratchetSensitivity", () => {
	it("escalates from Public to Confidential", () => {
		const session = makeSession();
		const escalated = ratchetSensitivity(session, ".env", "Confidential", DEFAULT_TAINT_CONFIG);
		expect(escalated).toBe(true);
		expect(session.sensitivity_level).toBe("Confidential");
		expect(session.taint_sources).toHaveLength(1);
		expect(session.taint_sources[0].file).toBe(".env");
	});

	it("does NOT downgrade sensitivity", () => {
		const session = makeSession();
		session.sensitivity_level = "HighlyConfidential";
		const escalated = ratchetSensitivity(session, "public.txt", "Public", DEFAULT_TAINT_CONFIG);
		expect(escalated).toBe(false);
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});

	it("tracks multiple taint sources", () => {
		const session = makeSession();
		ratchetSensitivity(session, ".env", "Confidential", DEFAULT_TAINT_CONFIG);
		ratchetSensitivity(session, "cert.pem", "HighlyConfidential", DEFAULT_TAINT_CONFIG);
		expect(session.taint_sources).toHaveLength(2);
		expect(session.sensitivity_level).toBe("HighlyConfidential");
	});
});

describe("shouldBlockNetwork", () => {
	it("blocks at Confidential when config says Confidential", () => {
		const session = makeSession();
		session.sensitivity_level = "Confidential";
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(true);
	});

	it("blocks at HighlyConfidential", () => {
		const session = makeSession();
		session.sensitivity_level = "HighlyConfidential";
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(true);
	});

	it("allows at Public", () => {
		const session = makeSession();
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(false);
	});

	it("allows at Internal (below Confidential threshold)", () => {
		const session = makeSession();
		session.sensitivity_level = "Internal";
		expect(shouldBlockNetwork(session, DEFAULT_TAINT_CONFIG)).toBe(false);
	});
});

describe("isNetworkCommand", () => {
	it("detects curl", () => {
		expect(isNetworkCommand("curl https://example.com")).toBe(true);
	});

	it("detects wget", () => {
		expect(isNetworkCommand("wget https://example.com/file")).toBe(true);
	});

	it("detects ssh/scp", () => {
		expect(isNetworkCommand("ssh user@host")).toBe(true);
		expect(isNetworkCommand("scp file user@host:")).toBe(true);
	});

	it("detects nc/netcat", () => {
		expect(isNetworkCommand("nc -l 4444")).toBe(true);
		expect(isNetworkCommand("netcat host 80")).toBe(true);
	});

	it("detects npm publish", () => {
		expect(isNetworkCommand("npm publish")).toBe(true);
	});

	it("does NOT flag non-network commands", () => {
		expect(isNetworkCommand("ls -la")).toBe(false);
		expect(isNetworkCommand("npm run build")).toBe(false);
		expect(isNetworkCommand("git status")).toBe(false);
	});
});

describe("isStepLimitExceeded", () => {
	it("returns false when under limit", () => {
		const session = makeSession();
		session.tool_call_count = 10;
		session.step_limit = 200;
		expect(isStepLimitExceeded(session)).toBe(false);
	});

	it("returns true when over limit", () => {
		const session = makeSession();
		session.tool_call_count = 201;
		session.step_limit = 200;
		expect(isStepLimitExceeded(session)).toBe(true);
	});

	it("returns false with infinite limit", () => {
		const session = makeSession();
		session.tool_call_count = 10000;
		expect(isStepLimitExceeded(session)).toBe(false);
	});
});

describe("SENSITIVITY_ORDER", () => {
	it("orders correctly", () => {
		expect(SENSITIVITY_ORDER.Public).toBeLessThan(SENSITIVITY_ORDER.Internal);
		expect(SENSITIVITY_ORDER.Internal).toBeLessThan(SENSITIVITY_ORDER.Confidential);
		expect(SENSITIVITY_ORDER.Confidential).toBeLessThan(SENSITIVITY_ORDER.HighlyConfidential);
	});
});
