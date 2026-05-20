import { beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/evaluator.js";

describe("evaluatePreToolUse — file & network guards", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		// Relax TDD enforce-mode for this non-TDD suite (see evaluator.test.ts).
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	// ===========================================
	// Protected Files
	// ===========================================

	describe("lock file and binary guards", () => {
		it("blocks editing package-lock.json", () => {
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "package-lock.json",
					old_string: '"version": "1.0.0"',
					new_string: '"version": "2.0.0"',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Lock files");
		});

		it("blocks writing to yarn.lock", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "yarn.lock", content: "# yarn lockfile" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks writing to binary files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "logo.png", content: "not a real png" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("binary");
		});

		it("allows writing to normal code files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "src/index.ts", content: "export const x = 1;" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	describe("sensitive file read blocking", () => {
		it("blocks reading .env", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: ".env" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("secrets");
		});

		it("blocks reading .env.local", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "/project/.env.local" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows reading .env.example", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: ".env.example" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks reading credentials.json", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "credentials.json" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks reading .pem files", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "server.pem" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});
	});

	describe("protected files", () => {
		it("blocks writing secrets to .env files", () => {
			// Reason: test fixture — a deliberately fake GH token pattern
			// assembled at runtime to exercise the secret-detection rule
			// without tripping the harness secrets scanner on the source file.
			// nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
			const fakeToken = `${"gh" + "p_"}1234567890abcdef1234567890abcdef1234`;
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: ".env",
					content: `API_KEY=${fakeToken}`,
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Secrets");
		});

		it("allows writing to .env without secrets", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: ".env",
					content: "NODE_ENV=production\nPORT=3000",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks reading private key files", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "certs/server.pem" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Private key");
		});
	});

	// ===========================================
	// Curl-to-MCP Detection
	// ===========================================

	describe("curl-to-MCP detection", () => {
		it("warns on curl to localhost:8787", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/health" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeDefined();
			expect(result.warnings?.[0]).toContain("localhost");
		});

		it("warns (not blocks) after configured threshold", () => {
			// Simulate 5 curl calls to same port
			for (let i = 0; i < 4; i++) {
				session.curl_localhost_count[8787] = i + 1;
			}

			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/api/test" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeDefined();
			expect(result.warnings?.some((w) => w.includes("disconnected"))).toBe(true);
		});

		it("does not warn for non-configured ports", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:9999/test" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeUndefined();
		});
	});

	// ===========================================
	// Auto File Reservation
	// ===========================================

	describe("auto file reservation", () => {
		it("allows first write to unreserved file", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "hello" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows same agent to write again to reserved file", () => {
			// First write creates reservation
			const event1 = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "hello" },
			});
			evaluatePreToolUse(event1, rules, session, reservations, cohort);

			// Second write by same agent (use Write, not Edit, to avoid old_string check)
			const event2 = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "world" },
			});
			const result = evaluatePreToolUse(event2, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Safe Commands (Should ALL Allow)
	// ===========================================

	describe("safe commands", () => {
		// `cat package.json` is intentionally NOT in this list: the
		// file-dump guard (`evaluator/file-dump-guard.ts`) blocks an
		// unfiltered cat on any file with >50 lines, which package.json
		// usually has. The pattern the agent should use is on the list
		// instead: `head -n 5 package.json` (explicit small slice).
		//
		// `npm install` is also NOT here — the supply-chain allowlist gate
		// (added 2026-05) now blocks bare installs until a snapshot is
		// approved. See `evaluator/package-install-guard.test.ts`.
		const safeCommands = [
			"ls -la",
			"npm run test",
			"git status",
			"git add .",
			"git commit -m 'test'",
			"git push origin main",
			"head -n 5 package.json",
			"echo hello",
			"node --version",
			"npx vitest run",
			"curl https://api.example.com",
		];

		for (const cmd of safeCommands) {
			it(`allows: ${cmd}`, () => {
				const event = makeEvent({ tool_input: { command: cmd } });
				const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
				expect(result.decision).toBe("allow");
			});
		}
	});
});
