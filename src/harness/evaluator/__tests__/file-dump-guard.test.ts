// Unit tests for the file-dump guard. Covers the three block conditions
// (foreground `tail -f`, file > 100KB unfiltered, lines > 50 unfiltered),
// the bypass cases (output redirection, filter pipeline, -c byte slice,
// background/nohup), and the legitimate-pattern negative set demanded by
// CLAUDE.md (≥3 positive + ≥3 negative).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFileDumpGuard } from "../file-dump-guard.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "file-dump-guard-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Helper: writes a file of the given approximate byte length and returns the path. */
function writeFile(name: string, bytes: number): string {
	const p = join(dir, name);
	writeFileSync(p, "x".repeat(bytes));
	return p;
}

/** Helper: writes a file with the given line count (one `x` per line). */
function writeFileLines(name: string, lineCount: number): string {
	const p = join(dir, name);
	writeFileSync(p, "x\n".repeat(lineCount));
	return p;
}

describe("evaluateFileDumpGuard — tail -f foreground", () => {
	it("blocks `tail -f foo.log` in the foreground", () => {
		const p = writeFile("foo.log", 100);
		const r = evaluateFileDumpGuard({ command: `tail -f ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
		if (r.kind === "block") {
			expect(r.decision.rule_id).toBe("builtin-tail-follow-foreground");
			expect(r.decision.reason).toMatch(/foreground/i);
		}
	});

	it("blocks `tail -F foo.log` (capital follow) in the foreground", () => {
		const p = writeFile("foo.log", 100);
		const r = evaluateFileDumpGuard({ command: `tail -F ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
	});

	it("blocks combined-flag `tail -nfF foo.log` (short-flag bundle)", () => {
		const p = writeFile("foo.log", 100);
		const r = evaluateFileDumpGuard({ command: `tail -nf 5 ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
	});

	it("allows `tail -f foo.log &` (explicit backgrounding)", () => {
		const p = writeFile("foo.log", 100);
		const r = evaluateFileDumpGuard({ command: `tail -f ${p} &`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `nohup tail -f foo.log` (nohup runs detached)", () => {
		const p = writeFile("foo.log", 100);
		const r = evaluateFileDumpGuard({ command: `nohup tail -f ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});
});

describe("evaluateFileDumpGuard — file size cap (100KB)", () => {
	it("blocks `cat big.log` when big.log > 100KB and no filter/redirect", () => {
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `cat ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
		if (r.kind === "block") {
			expect(r.decision.rule_id).toBe("builtin-file-dump-large-file");
			expect(r.decision.reason).toContain("200KB");
		}
	});

	it("blocks `head big.log` (default 10 lines) on large file without filter", () => {
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `head ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
		if (r.kind === "block") {
			expect(r.decision.rule_id).toBe("builtin-file-dump-large-file");
		}
	});

	it("allows `cat small.txt` (well under 100KB)", () => {
		const p = writeFile("small.txt", 4 * 1024);
		const r = evaluateFileDumpGuard({ command: `cat ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `cat big.log | jq -r .x` (filter present)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `cat ${p} | jq -r '.x'`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `cat big.log > out.txt` (redirected)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `cat ${p} > out.txt`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("blocks `cat small.txt big.log` (any file > 100KB triggers)", () => {
		const small = writeFile("small.txt", 1024);
		const big = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `cat ${small} ${big}`, cwd: dir });
		expect(r.kind).toBe("block");
		if (r.kind === "block") expect(r.decision.reason).toContain(big);
	});

	it("allows `cat big.log | cat` (`cat` is NOT a filter — but no -n means default 10 lines, and largest file > 100KB still blocks)", () => {
		// Sanity check: cat is correctly excluded from FILTER_COMMANDS.
		// This case still blocks because file size > 100KB.
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `cat ${p} | cat`, cwd: dir });
		expect(r.kind).toBe("block");
	});
});

describe("evaluateFileDumpGuard — line-count cap (50)", () => {
	it("blocks `head -n 100 foo` (over the 50-line cap, no filter)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `head -n 100 ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
		if (r.kind === "block") {
			expect(r.decision.rule_id).toBe("builtin-file-dump-too-many-lines");
			expect(r.decision.reason).toContain("100 lines");
		}
	});

	it("blocks `tail -n 200 foo` (well over the 50-line cap)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail -n 200 ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
	});

	it("blocks `tail -n=75 foo` (long-form `=` syntax)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail -n=75 ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
	});

	it("blocks `head --lines 100 foo` (long flag form)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `head --lines 100 ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
	});

	it("blocks `cat foo` when the file has > 50 lines (no filter, no redirect)", () => {
		// cat's "lines" is the file's actual newline count, so a file with
		// 100 lines blocks even though the size is well under 100KB.
		const p = writeFileLines("foo", 100);
		const r = evaluateFileDumpGuard({ command: `cat ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
		if (r.kind === "block") expect(r.decision.rule_id).toBe("builtin-file-dump-too-many-lines");
	});

	it("allows `cat foo` when the file has fewer than 50 lines", () => {
		// 30 lines of trivial content — actual output is ≤ 50 lines so the
		// line-count cap doesn't fire, and 30 lines × 2 bytes = 60 bytes is
		// well under the size cap.
		const p = writeFileLines("foo", 30);
		const r = evaluateFileDumpGuard({ command: `cat ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `tail -n 50 foo` (exactly at the cap)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail -n 50 ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `head -n 30 foo` (well under the cap)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `head -n 30 ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `tail foo` (default 10 lines on small file)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `tail -n 100 foo | grep INFO` (filter present)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail -n 100 ${p} | grep INFO`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `head -c 5000 big.log` (byte slice counts as filter on head/tail)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `head -c 5000 ${p}`, cwd: dir });
		expect(r.kind).toBe("allow");
	});
});

describe("evaluateFileDumpGuard — soft ceiling warning (1000 lines + filter)", () => {
	it("warns on `tail -n 5000 foo | jq -r .x` even with a filter", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({
			command: `tail -n 5000 ${p} | jq -r '.x'`,
			cwd: dir,
		});
		expect(r.kind).toBe("warn");
		if (r.kind === "warn") {
			expect(r.message).toMatch(/soft ceiling/i);
			expect(r.message).toContain("5000");
		}
	});

	it("allows `tail -n 1000 foo | jq` (at the soft ceiling)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail -n 1000 ${p} | jq`, cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `tail -n 1001 foo | jq` returns warn, not block", () => {
		// Sanity: just past the threshold goes to warn, not block. Filter is
		// what saves us from blocking, even if we're just over the ceiling.
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({ command: `tail -n 1001 ${p} | jq`, cwd: dir });
		expect(r.kind).toBe("warn");
	});
});

describe("evaluateFileDumpGuard — fail-open safety (uncertain inputs)", () => {
	it("allows `cat *.log` (glob — can't reliably stat)", () => {
		const r = evaluateFileDumpGuard({ command: "cat *.log", cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `cat $FILE` (env var substitution — opaque path)", () => {
		const r = evaluateFileDumpGuard({ command: "cat $FILE", cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `cat $(get_path)` (command substitution)", () => {
		const r = evaluateFileDumpGuard({ command: "cat $(get_path)", cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows `cat` with no file args (stdin source)", () => {
		const r = evaluateFileDumpGuard({ command: "cat", cwd: dir });
		expect(r.kind).toBe("allow");
	});

	it("allows non-dump commands (`ls -la`, `npm test`, etc.)", () => {
		expect(evaluateFileDumpGuard({ command: "ls -la", cwd: dir }).kind).toBe("allow");
		expect(evaluateFileDumpGuard({ command: "npm test", cwd: dir }).kind).toBe("allow");
		expect(evaluateFileDumpGuard({ command: "git status", cwd: dir }).kind).toBe("allow");
	});
});

describe("evaluateFileDumpGuard — wrapper handling", () => {
	it("blocks `sudo cat big.log` (sudo wrapper stripped, large-file block still fires)", () => {
		const p = writeFile("big.log", 200 * 1024);
		const r = evaluateFileDumpGuard({ command: `sudo cat ${p}`, cwd: dir });
		expect(r.kind).toBe("block");
	});

	it("blocks `env FOO=1 head -n 100 foo` (env wrapper stripped)", () => {
		const p = writeFile("foo", 1024);
		const r = evaluateFileDumpGuard({
			command: `env FOO=1 head -n 100 ${p}`,
			cwd: dir,
		});
		expect(r.kind).toBe("block");
	});
});

describe("evaluateFileDumpGuard — pipeline cases", () => {
	it("does not fire when tail is NOT the first pipeline segment", () => {
		// `echo X | tail -n 200`: tail is consuming stdin from echo, not a
		// file. We only inspect the first segment for the dump verb.
		const r = evaluateFileDumpGuard({
			command: "echo hello | tail -n 200",
			cwd: dir,
		});
		expect(r.kind).toBe("allow");
	});

	it("allows `cat foo | grep err | head -n 1` (multi-stage pipeline with filter)", () => {
		const p = writeFile("foo", 4 * 1024);
		const r = evaluateFileDumpGuard({
			command: `cat ${p} | grep err | head -n 1`,
			cwd: dir,
		});
		expect(r.kind).toBe("allow");
	});

	it("does NOT mistake `||` for a pipeline boundary", () => {
		// `true || cat huge.log` — first segment is `true ||...`, so we should
		// not see `cat` as a dump verb here. (In practice command-decomposition
		// upstream splits on `||`, but the guard should still be robust.)
		const r = evaluateFileDumpGuard({
			command: "true || cat foo.log",
			cwd: dir,
		});
		expect(r.kind).toBe("allow");
	});
});

describe("evaluateFileDumpGuard — first-command-group bounding", () => {
	it("does not leak a later `sed -n` count onto a leading head (2026-06-12 misreport)", () => {
		// The exact shape that misfired: a small head, then unrelated commands,
		// then `sed -n '295,350p'`. The trailing `-n 295` must not be attributed
		// to `head` (sed is not even a dump verb).
		const p = writeFileLines("git.rs", 5);
		const r = evaluateFileDumpGuard({
			command: `head -3 ${p}; echo ===; sed -n '295,350p' ${p}`,
			cwd: dir,
		});
		expect(r.kind).toBe("allow");
	});

	it("does not leak a later command's -n across &&", () => {
		const p = writeFileLines("a.txt", 5);
		const r = evaluateFileDumpGuard({
			command: `head -3 ${p} && grep x ${p} | head -n 9999`,
			cwd: dir,
		});
		expect(r.kind).toBe("allow");
	});

	it("still blocks a genuine unfiltered over-cap dump in the first group", () => {
		const p = writeFileLines("big.txt", 500);
		const r = evaluateFileDumpGuard({
			command: `head -n 300 ${p}; echo done`,
			cwd: dir,
		});
		expect(r.kind).toBe("block");
	});

	it("does not split on a semicolon inside quotes", () => {
		const p = writeFileLines("c.txt", 5);
		const r = evaluateFileDumpGuard({
			command: `awk 'BEGIN{print "a;b"}' ${p} | head -n 2`,
			cwd: dir,
		});
		// awk is the verb, not a dump verb → allow; the quoted `;` must not
		// truncate the group mid-quote.
		expect(r.kind).toBe("allow");
	});
});
