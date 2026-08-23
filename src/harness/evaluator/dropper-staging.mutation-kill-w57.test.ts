import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectDropperStaging } from "./dropper-staging.js";

describe("detectDropperStaging — mutation-kill w57", () => {
	// mutantId 2c4a34c417b1c7a0 — LogicalOperator: match[1] ?? match[2] -> match[1] && match[2]
	// A quoted exec target sets match[1] and leaves match[2]/match[3] undefined. Under the
	// mutant, `match[1] && match[2]` collapses to undefined, so the target is never pushed
	// and the whole staging attempt is missed.
	// test-contract: public-api — detectDropperStaging must report a quoted exec target
	// under a temp root (module doc: "EXECUTION has no scratchpad carve-out").
	it("finds a quoted bash exec target inside a temp dir", () => {
		expect(detectDropperStaging('bash "/tmp/malicious.sh"', undefined)).toBe(
			"/tmp/malicious.sh",
		);
	});

	// mutantId eac9f85018aeea71 — ConditionalExpression: isEphemeralTempPath(target) -> true
	// A non-ephemeral exec target must NOT be reported as staging.
	// test-contract: public-api — detectDropperStaging returns null when the exec target
	// is not under any recognized ephemeral temp root (isEphemeralTempPath contract).
	it("does not flag an exec target outside any temp dir", () => {
		expect(detectDropperStaging("bash /home/user/script.sh", undefined)).toBeNull();
	});

	// mutantId d1a88b8a6af0e5e4 — ConditionalExpression: sessionScratchpadAllows(...) -> false
	// A redirect target inside the session's own scratchpad must be allowed (skipped).
	// test-contract: public-api — module doc item 1: the host session scratchpad is a
	// sanctioned write target, so detectDropperStaging must not flag it.
	it("does not flag a redirect into the session's own scratchpad", () => {
		const sessionId = "sess-w57-abc";
		const target = `${tmpdir()}/${sessionId}/scratchpad/payload.sh`;
		expect(detectDropperStaging(`cat x > ${target}`, sessionId)).toBeNull();
	});

	// mutantId baecd3ad6406cbca — Regex: DATA_SINK_EXT loses its trailing `$` anchor.
	// Without the anchor, ".log" appearing mid-filename (not as the real suffix) would
	// be misread as a safe data-sink extension.
	// test-contract: public-api — DATA_SINK_EXT must match only the true trailing extension,
	// so a ".sh" target with ".log" mid-name is still reported as staging.
	it("flags a redirect target whose extension is .sh even though '.log' appears mid-name", () => {
		expect(detectDropperStaging("cat data > /tmp/malicious.log.sh", undefined)).toBe(
			"/tmp/malicious.log.sh",
		);
	});

	// mutantId 04bc6f64d13dd493 — Regex: `ya?ml$` -> `yaml$`, losing the `.yml` short form.
	// test-contract: public-api — DATA_SINK_EXT's own comment lists `.log/…` as data-sink
	// suffixes; `.yml` (the short YAML form) must be recognized as such (item 2, module doc).
	it("treats a .yml redirect target as a safe data sink (not staging)", () => {
		expect(detectDropperStaging("cat data > /tmp/config.yml", undefined)).toBeNull();
	});

	// mutantId 73984432013cb179 / cd39642f81b54134 — Regex: tee-flag `\s+-\S+` mangled to
	// `\s-\S+` (exactly one whitespace) or `\s+-\s+` (dash must be followed by whitespace).
	// Two spaces before the flag exercises the `\s+` (one-or-more) requirement.
	// test-contract: public-api — REDIRECT_TARGET_RE's tee-flag group must tolerate
	// multiple whitespace chars before a flag, per its own `\s+` quantifier.
	it("resolves the redirect target past a two-space tee flag", () => {
		expect(detectDropperStaging("tee  -a /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId 4dc22be2bffb0326 / cd39642f81b54134 — Regex: `\s+-\S+` -> `\S+-\S+` (needs a
	// non-whitespace char before the dash) or `-\s+` (dash needs whitespace after it). A
	// single space before a real flag exercises both breakages.
	// test-contract: public-api — REDIRECT_TARGET_RE must resolve the actual redirect
	// target past a normal single-space `tee -a` flag (the common real-world shape).
	it("resolves the redirect target past a single-space tee flag", () => {
		expect(detectDropperStaging("tee -a /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId dee234b21f960843 — Regex: tee-flag value `-\S+` -> `-\S` (exactly one char),
	// breaking on a multi-character flag value.
	// test-contract: public-api — REDIRECT_TARGET_RE's flag-value class is `\S+`
	// (one-or-more), so a multi-char flag like `-aa` must not break target resolution.
	it("resolves the redirect target past a multi-char tee flag", () => {
		expect(detectDropperStaging("tee -aa /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId dad4ce987cec69da — Regex: the mandatory `\s*` before the target group loses
	// its `*`, becoming a mandatory single whitespace — breaking a target glued directly to
	// the redirect operator with no space.
	// test-contract: public-api — the module comment states the regex captures `>` /
	// `>>` targets; `>file` (no space) is valid shell syntax and must still resolve.
	it("resolves a redirect target with no space after the operator", () => {
		expect(detectDropperStaging("echo x >/tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId b240c929c375a8ef / 9a7e12aec7894a31 — Regex: the double-quoted content class
	// in the redirect target group is narrowed to exactly one char, or flipped to match only
	// quote characters. A multi-char, quote-free double-quoted target exercises both.
	// test-contract: public-api — REDIRECT_TARGET_RE's double-quote branch (`[^"]+`)
	// must capture the full quoted content, not a single char or quote-only run.
	it("resolves a double-quoted, multi-char redirect target", () => {
		expect(detectDropperStaging('cat x > "/tmp/payload.sh"', undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId 147d04a458e3b81e / 79fe11019cc8bf89 — Regex: the single-quoted content class
	// in the redirect target group is narrowed to exactly one char, or flipped to match only
	// quote characters. A multi-char, quote-free single-quoted target exercises both.
	// test-contract: public-api — REDIRECT_TARGET_RE's single-quote branch (`[^']+`)
	// must capture the full quoted content, not a single char or quote-only run.
	it("resolves a single-quoted, multi-char redirect target", () => {
		expect(detectDropperStaging("cat x > '/tmp/payload.sh'", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId 7123024b43147293 — Regex: `chmod\s+` -> `chmod\s` (exactly one whitespace),
	// breaking on two spaces after "chmod".
	// test-contract: public-api — EXEC_TARGET_RE's `chmod\s+` must tolerate more than
	// one whitespace char after the keyword, per its own `\s+` quantifier.
	it("resolves the exec target past two spaces after chmod", () => {
		expect(detectDropperStaging("chmod  +x /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId e51da274d568e750 — Regex: `\+?` -> `\+` (the leading plus becomes mandatory),
	// breaking on a chmod invocation with no plus sign.
	// test-contract: public-api — EXEC_TARGET_RE's `\+?` is optional, so a `chmod`
	// invocation with no plus sign must still resolve its exec target.
	it("resolves a chmod exec target with no plus sign", () => {
		expect(detectDropperStaging("chmod 700x /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId edb357cfb45caa15 — Regex: `[0-7]*` -> `[^0-7]*` (digit class negated),
	// breaking on an actual octal digit.
	// test-contract: public-api — EXEC_TARGET_RE's `[0-7]*` must accept real octal
	// digits (its own name and comment: "chmod +?[0-7]*x" permission-change shape).
	it("resolves a chmod exec target with an octal digit before x", () => {
		expect(detectDropperStaging("chmod +7x /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId 35d6c3fc8bff0b03 — Regex: `python3?` -> `python3` (the trailing digit becomes
	// mandatory), breaking on plain "python".
	// test-contract: public-api — EXEC_TARGET_RE's `python3?` makes the digit optional,
	// so plain `python` (not just `python3`) must still resolve an exec target.
	it("resolves a plain 'python' exec target (no trailing 3)", () => {
		expect(detectDropperStaging("python /tmp/payload.py", undefined)).toBe(
			"/tmp/payload.py",
		);
	});

	// mutantId 8a4885ea5daa285b — Regex: the mandatory `\s+` between keyword and target
	// loses its `+`, becoming exactly one whitespace — breaking on two spaces.
	// test-contract: public-api — EXEC_TARGET_RE's keyword-to-target separator is `\s+`
	// (one-or-more), so two spaces after `bash` must still resolve the exec target.
	it("resolves the exec target past two spaces after a bare keyword", () => {
		expect(detectDropperStaging("bash  /tmp/payload.sh", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId 9855bb6501c6693b / e26a763167f7f4e3 — Regex: the double-quoted content class
	// in the EXEC target group is flipped to match only quote chars, or narrowed to exactly
	// one char. A multi-char, quote-free double-quoted target exercises both.
	// test-contract: public-api — EXEC_TARGET_RE's double-quote branch (`[^"]+`) must
	// capture the full quoted content, not a single char or quote-only run.
	it("resolves a double-quoted, multi-char exec target", () => {
		expect(detectDropperStaging('bash "/tmp/payload.sh"', undefined)).toBe(
			"/tmp/payload.sh",
		);
	});

	// mutantId a49507fe226b9dbf / 9c639f00aea97981 — Regex: the single-quoted content class
	// in the EXEC target group is narrowed to exactly one char, or flipped to match only
	// quote characters. A multi-char, quote-free single-quoted target exercises both.
	// test-contract: public-api — EXEC_TARGET_RE's single-quote branch (`[^']+`) must
	// capture the full quoted content, not a single char or quote-only run.
	it("resolves a single-quoted, multi-char exec target", () => {
		expect(detectDropperStaging("bash '/tmp/payload.sh'", undefined)).toBe(
			"/tmp/payload.sh",
		);
	});
});
