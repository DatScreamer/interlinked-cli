import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	computeCyclomaticPython,
	type PythonSpawnFn,
	parseRadonJson,
	radonAvailable,
} from "./cyclomatic-python.js";

/** Build the narrow spawn-result shape `PythonSpawnFn` returns. */
function spawnResult(opts: {
	status?: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException;
}): Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error"> {
	const base: Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr"> = {
		status: opts.status === undefined ? 0 : opts.status,
		stdout: opts.stdout ?? "",
		stderr: opts.stderr ?? "",
	};
	return opts.error ? { ...base, error: opts.error } : base;
}

/** A fake radon spawn that returns a JSON payload keyed by the temp path radon
 *  was handed (argv[3] is the temp file). Records the args for assertions. */
function fakeRadon(blocksByCall: {
	version?: string;
	cc: (tmpFile: string) => unknown;
	ccError?: NodeJS.ErrnoException;
	ccStatus?: number | null;
}): { spawn: PythonSpawnFn; calls: { command: string; args: readonly string[] }[] } {
	const calls: { command: string; args: readonly string[] }[] = [];
	const spawn: PythonSpawnFn = (command, args) => {
		calls.push({ command, args });
		if (args[0] === "--version") {
			return spawnResult({ status: 0, stdout: blocksByCall.version ?? "radon 6.0.1" });
		}
		// cc invocation: argv = ["cc", "--json", "-s", <tmpFile>]
		if (blocksByCall.ccError) return spawnResult({ error: blocksByCall.ccError });
		const tmpFile = args[3] ?? "";
		const payload = blocksByCall.cc(tmpFile);
		return spawnResult({
			status: blocksByCall.ccStatus === undefined ? 0 : blocksByCall.ccStatus,
			stdout: JSON.stringify(payload),
		});
	};
	return { spawn, calls };
}

/** A radon `function` block with the given complexity. */
function fnBlock(name: string, complexity: number, lineno = 1, endline = 10) {
	return { type: "function", name, complexity, lineno, endline, col_offset: 0, rank: "A" };
}

describe("parseRadonJson", () => {
	it("flattens functions, methods, and nested closures into one entry each", () => {
		const payload = {
			"/tmp/x.py": [
				fnBlock("top_level", 3, 1, 5),
				{
					type: "class",
					name: "C",
					complexity: 12, // aggregate — MUST NOT be emitted (would double-count)
					lineno: 7,
					endline: 30,
					methods: [
						{ type: "method", name: "method_a", complexity: 4, lineno: 8, endline: 15 },
						{
							type: "method",
							name: "method_b",
							complexity: 5,
							lineno: 16,
							endline: 30,
							closures: [{ type: "function", name: "inner", complexity: 2, lineno: 18, endline: 20 }],
						},
					],
				},
			],
		};
		const entries = parseRadonJson(JSON.stringify(payload)) ?? [];
		const names = entries.map((e) => e.name).sort();
		expect(names).toEqual(["inner", "method_a", "method_b", "top_level"]);
		// class aggregate not present:
		expect(entries.find((e) => e.name === "C")).toBeUndefined();
		const methodA = entries.find((e) => e.name === "method_a");
		expect(methodA?.cyclomatic).toBe(4);
		expect(methodA?.line).toBe(8);
		expect(methodA?.endLine).toBe(15);
		expect(methodA?.language).toBe("python");
		// sorted ascending by line:
		expect(entries.map((e) => e.line)).toEqual([1, 8, 16, 18]);
	});

	it("returns [] for a valid but function-free file (NOT null)", () => {
		expect(parseRadonJson(JSON.stringify({ "/tmp/empty.py": [] }))).toEqual([]);
	});

	it("returns null when the only file entry is a radon parse error (fail open, not 'simple')", () => {
		const payload = { "/tmp/broken.py": { error: "invalid syntax (broken.py, line 3)" } };
		expect(parseRadonJson(JSON.stringify(payload))).toBeNull();
	});

	it("returns null for non-JSON stdout", () => {
		expect(parseRadonJson("not json at all")).toBeNull();
	});
});

describe("radonAvailable", () => {
	it("true when --version exits 0", () => {
		const { spawn } = fakeRadon({ cc: () => ({}) });
		expect(radonAvailable(spawn)).toBe(true);
	});

	it("false when spawn surfaces ENOENT (radon not installed)", () => {
		const enoent = Object.assign(new Error("spawn radon ENOENT"), { code: "ENOENT" });
		const spawn: PythonSpawnFn = () => spawnResult({ error: enoent, status: null });
		expect(radonAvailable(spawn)).toBe(false);
	});

	it("false when --version exits nonzero", () => {
		const spawn: PythonSpawnFn = () => spawnResult({ status: 1 });
		expect(radonAvailable(spawn)).toBe(false);
	});
});

describe("computeCyclomaticPython", () => {
	it("returns per-function entries for a clean radon run", () => {
		const { spawn, calls } = fakeRadon({
			cc: (tmpFile) => ({ [tmpFile]: [fnBlock("greet", 1, 1, 2), fnBlock("dispatch", 7, 4, 20)] }),
		});
		const entries = computeCyclomaticPython("def greet():\n  pass\n", "src/app.py", spawn);
		expect(entries).not.toBeNull();
		expect(entries?.map((e) => e.name)).toEqual(["greet", "dispatch"]);
		expect(entries?.find((e) => e.name === "dispatch")?.cyclomatic).toBe(7);
		// invoked radon cc --json -s <tmpfile>:
		const ccCall = calls.find((c) => c.args[0] === "cc");
		expect(ccCall?.args.slice(0, 3)).toEqual(["cc", "--json", "-s"]);
		expect(ccCall?.args[3]).toMatch(/\.py$/);
	});

	it("returns null (loud degrade) when radon is unavailable — ENOENT", () => {
		const enoent = Object.assign(new Error("spawn radon ENOENT"), { code: "ENOENT" });
		const out = computeCyclomaticPython("def f():\n  pass\n", "src/x.py", () =>
			spawnResult({ error: enoent, status: null }),
		);
		expect(out).toBeNull(); // NOT [] — a missing radon must not read as "no functions"
	});

	it("returns null when radon exits nonzero", () => {
		const out = computeCyclomaticPython("def f():\n  pass\n", "src/x.py", () =>
			spawnResult({ status: 2, stdout: "" }),
		);
		expect(out).toBeNull();
	});

	it("returns null when the spawn call throws", () => {
		const out = computeCyclomaticPython("def f():\n  pass\n", "src/x.py", () => {
			throw new Error("boom");
		});
		expect(out).toBeNull();
	});
});
