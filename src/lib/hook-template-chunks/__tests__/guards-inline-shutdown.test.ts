// Regression test: the inline-hook fallback's shutdown/reboot regex must
// stay in lockstep with the harness rule at
// `src/harness/rules/builtin-rules-processes.ts:builtin-shutdown-reboot`.
// Divergence means a command the daemon allows can still be blocked when
// the harness is down (and vice versa) — exactly the FN/FP class of issue
// the reviewer flagged for Plan 08's daemon work.

import { describe, expect, it } from "vitest";
import { GUARDS_INLINE_CHUNK } from "../guards-inline.js";

// Pull the inline regex out of the chunk source so the test exercises the
// EXACT pattern the .mjs runtime evaluates. The chunk is a string template
// where `\\` in source becomes `\` in the emitted .mjs, so we have to undo
// one level of escaping when reconstructing the runtime regex.
function buildRuntimeRegex(): RegExp {
	// Match the test-line for the shutdown/reboot rule directly. Chunk source
	// shape: `if (/<body>/i.test(cmd)) { ... shutdown/reboot ... }`. The
	// rule's pattern is unique enough — `shutdown|reboot|halt|poweroff` —
	// that we can search for it inside a `/i.test(cmd)` line specifically.
	const lineRe =
		/if \(\/((?:[^/\\]|\\.)+?)\/i\.test\(cmd\)\)\s*\{\s*\n[^}]*shutdown\/reboot/m;
	const m = lineRe.exec(GUARDS_INLINE_CHUNK);
	if (!m) throw new Error("inline-hook shutdown regex not found in chunk");
	// `\\` in the chunk source → `\` in the runtime, because the chunk is a
	// string template that becomes the .mjs source. Undo one level of
	// escaping so we test against the exact runtime regex.
	const body = m[1].replace(/\\\\/g, "\\");
	return new RegExp(body, "i");
}

function runInlineGuard(command: string): { decision: string; reason: string } | null {
	const fn = new Function(`${GUARDS_INLINE_CHUNK}\nreturn inlineGuardCheck;`)() as (
		hookEvent: string,
		toolName: string,
		toolInput: { command: string },
	) => { decision: string; reason: string } | null;
	return fn("PreToolUse", "Bash", { command });
}

describe("inline-hook fallback shutdown regex (Plan 08 review parity fix)", () => {
	const re = buildRuntimeRegex();

	// FN regression set (must match — agent must be blocked even with harness down).
	it("blocks `shutdown -h now`", () => {
		expect(re.test("shutdown -h now")).toBe(true);
	});

	it("blocks `sudo reboot`", () => {
		expect(re.test("sudo reboot")).toBe(true);
	});

	it("blocks reboot at the right side of a pipeline", () => {
		expect(re.test("printf x | sudo reboot")).toBe(true);
	});

	it("blocks reboot after a newline", () => {
		expect(re.test("echo ok\nreboot")).toBe(true);
	});

	it("blocks shutdown after `;`", () => {
		expect(re.test("echo done; shutdown -h now")).toBe(true);
	});

	it("blocks shutdown after `||`", () => {
		expect(re.test("false || shutdown -h now")).toBe(true);
	});

	it("blocks shutdown after `&&`", () => {
		expect(re.test("foo && shutdown -h now")).toBe(true);
	});

	// Wrapper-form regression set. An anchor-only regex misses these even
	// though each actually executes the destructive verb at runtime. Inline
	// fallback must stay in lockstep with the harness rule.
	it("blocks `env FOO=1 reboot`", () => {
		expect(re.test("env FOO=1 reboot")).toBe(true);
	});

	it("blocks `command reboot`", () => {
		expect(re.test("command reboot")).toBe(true);
	});

	it("blocks `bash -c reboot`", () => {
		expect(re.test("bash -c reboot")).toBe(true);
	});

	it('blocks `bash -c "reboot"`', () => {
		expect(re.test('bash -c "reboot"')).toBe(true);
	});

	it("blocks `nohup reboot`", () => {
		expect(re.test("nohup reboot")).toBe(true);
	});

	it("blocks `exec reboot`", () => {
		expect(re.test("exec reboot")).toBe(true);
	});

	it("blocks combined wrappers (`sudo bash -c reboot`)", () => {
		expect(re.test("sudo bash -c reboot")).toBe(true);
	});

	it("blocks `env A=1 B=2 sudo reboot`", () => {
		expect(re.test("env A=1 B=2 sudo reboot")).toBe(true);
	});

	// Negative: `bash -c "echo Graceful shutdown stalled"` must still NOT
	// match — the verb position falls on `echo`, not a destructive verb.
	it("does NOT block `bash -c \"echo Graceful shutdown stalled\"`", () => {
		expect(re.test('bash -c "echo Graceful shutdown stalled"')).toBe(false);
	});

	// FP regression set (must NOT match — these are the cases the prior
	// `\s` prefix incorrectly flagged, motivating the original change).
	it("allows the word 'shutdown' inside an echo argument", () => {
		expect(re.test('echo "Graceful shutdown stalled"')).toBe(false);
	});

	it("allows grep with 'Shutting down' as a search pattern", () => {
		expect(re.test("grep -n 'Shutting down' src/server.ts")).toBe(false);
	});

	it("allows reading shutdown.log", () => {
		expect(re.test("cat ./shutdown.log")).toBe(false);
	});

	it("actual inline guard blocks pipeline shutdown even when the command starts with printf", () => {
		expect(runInlineGuard("printf x | sudo reboot")?.decision).toBe("block");
	});

	it("actual inline guard blocks newline shutdown even when the command starts with echo", () => {
		expect(runInlineGuard("echo ok\nreboot")?.decision).toBe("block");
	});

	it("actual inline guard allows rg patterns that mention wrapped reboot as data", () => {
		expect(runInlineGuard("rg -n 'foo|command reboot' src")).toBeNull();
	});

	it("actual inline guard allows quoted echo text with a pipe before reboot", () => {
		expect(runInlineGuard('echo "foo | reboot"')).toBeNull();
	});
});
