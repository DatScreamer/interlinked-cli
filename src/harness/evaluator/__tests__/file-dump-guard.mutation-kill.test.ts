import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateFileDumpGuard } from "../file-dump-guard.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "file-dump-guard-mutants-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function bytes(name: string, count: number): string {
	return file(name, "x".repeat(count));
}

describe("evaluateFileDumpGuard mutation boundaries", () => {
	it("returns the complete allow result for an empty command", () => {
		expect(evaluateFileDumpGuard({ command: "", cwd: dir })).toEqual({ kind: "allow" });
	});

	it("does not treat a non-dump command with a file as a dump", () => {
		const path = file("small.txt", "x\n");
		expect(evaluateFileDumpGuard({ command: `ls -n 300 ${path}`, cwd: dir })).toEqual({ kind: "allow" });
	});

	it("does not apply tail-follow blocking to head -f", () => {
		const path = file("small.log", "x\n");
		expect(evaluateFileDumpGuard({ command: `head -f ${path}`, cwd: dir })).toEqual({ kind: "allow" });
	});

	it("recognizes an explicit byte slice only for head and tail", () => {
		const path = bytes("large.log", 200 * 1024);
		expect(evaluateFileDumpGuard({ command: `head -c 10 ${path}`, cwd: dir })).toEqual({ kind: "allow" });
		expect(evaluateFileDumpGuard({ command: `tail -c 10 ${path}`, cwd: dir })).toEqual({ kind: "allow" });
		expect(evaluateFileDumpGuard({ command: `cat -c 10 ${path}`, cwd: dir })).toMatchObject({
			kind: "block",
			decision: { rule_id: "builtin-file-dump-large-file" },
		});
	});
});

describe("file-dump guard follow decision", () => {
	it("requires the ampersand to be the final shell token", () => {
		const path = file("follow.log", "x\n");
		expect(evaluateFileDumpGuard({ command: `tail -f ${path} &`, cwd: dir })).toEqual({ kind: "allow" });
		expect(evaluateFileDumpGuard({ command: `tail -f ${path} & echo after`, cwd: dir })).toMatchObject({
			kind: "block",
			decision: { rule_id: "builtin-tail-follow-foreground" },
		});
	});

	it("does not mistake a later nohup token for a nohup wrapper", () => {
		const path = file("follow.log", "x\n");
		expect(evaluateFileDumpGuard({ command: `tail -f ${path} nohup`, cwd: dir })).toMatchObject({
			kind: "block",
			decision: { rule_id: "builtin-tail-follow-foreground" },
		});
	});

	it("preserves every foreground-follow decision field and guidance clause", () => {
		const path = file("follow.log", "x\n");
		const result = evaluateFileDumpGuard({ command: `tail -f ${path}`, cwd: dir });
		expect(result).toMatchObject({
			kind: "block",
			decision: {
				decision: "block",
				rule_id: "builtin-tail-follow-foreground",
				severity: "high",
				category: "command-shape",
			},
		});
		if (result.kind === "block") {
			expect(result.decision.reason).toContain("will hang the tool call indefinitely");
			expect(result.decision.reason).toContain("Run it in the background");
			expect(result.decision.reason).toContain("use the runner's background flag");
			expect(result.decision.reason).toContain("use the Monitor tool for streaming output");
		}
	});
});

describe("file-dump guard filtered and terminal boundaries", () => {
	it("warns when a filtered pipeline is not terminally bounded", () => {
		const path = file("data.log", "x\n");
		const result = evaluateFileDumpGuard({ command: `tail -n 5000 ${path} | grep x | sort`, cwd: dir });
		expect(result).toMatchObject({ kind: "warn" });
		if (result.kind === "warn") {
			expect(result.message).toContain("past the 1000-line soft ceiling");
			expect(result.message).toContain("tighten the line count if you can");
		}
	});

	it("warns for a byte-sliced single-stage dump over the filtered ceiling", () => {
		const path = file("data.log", "x\n");
		expect(evaluateFileDumpGuard({ command: `head -n 5000 -c 10 ${path}`, cwd: dir })).toMatchObject({ kind: "warn" });
	});

	it("does not treat an unrecognized final stage as a bounding command", () => {
		const path = file("data.log", "x\n");
		expect(evaluateFileDumpGuard({ command: `tail -n 5000 ${path} | grep x | $UNKNOWN`, cwd: dir })).toMatchObject({
			kind: "warn",
		});
	});
});

describe("file-dump guard file statistics", () => {
	it("uses the first largest file when a later file is smaller", () => {
		const large = bytes("large.log", 200 * 1024);
		const small = bytes("small.log", 100);
		const result = evaluateFileDumpGuard({ command: `cat ${large} ${small}`, cwd: dir });
		expect(result).toMatchObject({ kind: "block", decision: { rule_id: "builtin-file-dump-large-file" } });
		if (result.kind === "block") {
			expect(result.decision.reason).toContain(large);
			expect(result.decision.reason).not.toContain(small);
		}
	});

	it("keeps an equal-sized first file as the reported largest path", () => {
		const first = bytes("first.log", 200 * 1024);
		const second = bytes("second.log", 200 * 1024);
		const result = evaluateFileDumpGuard({ command: `cat ${first} ${second}`, cwd: dir });
		expect(result).toMatchObject({ kind: "block", decision: { rule_id: "builtin-file-dump-large-file" } });
		if (result.kind === "block") {
			expect(result.decision.reason).toContain(first);
			expect(result.decision.reason).not.toContain(second);
		}
	});

	it("blocks an unstatable path conservatively and describes it as an entire file", () => {
		const missing = join(dir, "does-not-exist.log");
		const result = evaluateFileDumpGuard({ command: `cat ${missing}`, cwd: dir });
		expect(result).toMatchObject({ kind: "block", decision: { rule_id: "builtin-file-dump-too-many-lines" } });
		if (result.kind === "block") expect(result.decision.reason).toContain("an entire file");
	});

	it("blocks exactly 100 KiB only when the strict size threshold is exceeded", () => {
		const path = bytes("exact.log", 100 * 1024);
		expect(evaluateFileDumpGuard({ command: `cat ${path}`, cwd: dir })).toEqual({ kind: "allow" });
	});
});

describe("file-dump guard recognizes every configured downstream filter", () => {
	for (const filter of [
		"egrep",
		"fgrep",
		"rg",
		"ripgrep",
		"ag",
		"awk",
		"gawk",
		"sed",
		"mawk",
		"head",
		"tail",
		"wc",
		"cut",
		"sort",
		"uniq",
		"fzf",
		"less",
		"more",
	]) {
		it(`treats ${filter} as a downstream filter`, () => {
			const path = bytes("large.log", 200 * 1024);
			expect(evaluateFileDumpGuard({ command: `cat ${path} | ${filter}`, cwd: dir })).toEqual({ kind: "allow" });
		});
	}
});
