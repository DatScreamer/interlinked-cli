// Behavioral unit tests for the four misc structural checks.
//
// All four functions are pure given their inputs except for two filesystem
// touches (`readFileSync` / `existsSync`, both from `node:fs`) and one clock
// read (`Date.now()` via `new Date()` arithmetic). We mock `node:fs` at the
// module boundary and drive the clock with vitest fake timers, so every test
// is fully deterministic. ProjectGraph / SessionTracker are stubbed with
// duck-typed objects exposing only the methods each function calls (the
// `as unknown as` idiom used across this repo, e.g. dead-exports.test.ts).
//
// Coverage goal: every branch — if/else, ternary, &&/||/??, the readFileSync
// catch, and each early-return guard. No tombstone tests; every case asserts
// a real returned StructuralCheckResult[] shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGraph } from "../project-graph.js";
import type { SessionTracker } from "../session-state.js";
import type { HarnessEvent, ImportEdge } from "../types.js";
import type { SessionTrajectory } from "../types/session.js";

// --- node:fs mock ------------------------------------------------------------
// checkJSDocParamMismatch -> readFileSync; checkTestProximity -> existsSync.
vi.mock("node:fs", () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import {
	checkCoDependencyStaleness,
	checkInterfaceChangeImpact,
	checkJSDocParamMismatch,
	checkTestProximity,
} from "./misc-checks.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

// --- fixture helpers ---------------------------------------------------------

/** Minimal HarnessEvent — only `agent_name` is read by these checks. */
function makeEvent(agentName?: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s1",
		agent_source: "claude",
		agent_name: agentName,
		timestamp: "2026-06-05T00:00:00Z",
	} as HarnessEvent;
}

/** A session trajectory stub with only the fields the checks read. */
function makeSession(opts: {
	agent_name: string;
	started_at?: string;
	files_read?: string[];
	files_written?: string[];
}): SessionTrajectory {
	return {
		agent_name: opts.agent_name,
		started_at: opts.started_at ?? "2026-06-05T00:00:00Z",
		files_read: new Set(opts.files_read ?? []),
		files_written: new Set(opts.files_written ?? []),
	} as unknown as SessionTrajectory;
}

function makeSessions(list: SessionTrajectory[]): SessionTracker {
	return {
		getAll: vi.fn().mockReturnValue(list),
	} as unknown as SessionTracker;
}

function edge(symbols: string[], fromFile: string): ImportEdge {
	return {
		fromFile,
		toFile: "/proj/target.ts",
		specifier: "./target",
		symbols,
		isTypeOnly: false,
	};
}

/** Stub graph exposing only the methods the misc checks consume. */
function makeGraph(opts: {
	dependents?: string[];
	interfaceBodies?: Map<string, string>;
	importers?: ImportEdge[];
	toRelative?: (f: string) => string;
}): ProjectGraph {
	return {
		getDependents: vi.fn().mockReturnValue(opts.dependents ?? []),
		getInterfaceBodies: vi.fn().mockReturnValue(opts.interfaceBodies ?? new Map()),
		getImporters: vi.fn().mockReturnValue(opts.importers ?? []),
		// Default toRelative strips a leading "/proj/" for readable assertions.
		toRelative: opts.toRelative ?? ((f: string) => f.replace(/^\/proj\//, "")),
	} as unknown as ProjectGraph;
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ============================================================================
// checkCoDependencyStaleness
// ============================================================================

describe("checkCoDependencyStaleness", () => {
	const FILE = "/proj/target.ts";
	const REL = "target.ts";

	// Pin the clock so `now - new Date(started_at)` is deterministic.
	const NOW = new Date("2026-06-05T01:00:00Z").getTime();
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns [] when the file has no dependents (L32 guard)", () => {
		const graph = makeGraph({ dependents: [] });
		const sessions = makeSessions([
			makeSession({ agent_name: "other", files_read: ["/proj/dep.ts"] }),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
		// getAll must not be reached on the no-dependents fast path.
		expect(sessions.getAll).not.toHaveBeenCalled();
	});

	it("skips the editing agent's own session (L39 continue)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// Only session is the same agent doing the edit -> no affected agents.
		const sessions = makeSessions([
			makeSession({
				agent_name: "me",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	it("ignores a session that did not read any dependent (L42 false)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "other",
				files_read: ["/proj/unrelated.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	it("ignores a stale session whose age exceeds the window (L47 false)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// Started 2h ago; window is 1h -> sessionAge >= stalenessMs.
		const sessions = makeSessions([
			makeSession({
				agent_name: "other",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-04T23:00:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toEqual([]);
	});

	it("warns when a recent other-agent session read a dependent (happy path)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "alice",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:00Z", // 1 min ago < 1h window
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "co_dependency_staleness",
			severity: "info",
			file: FILE,
			affectedFiles: ["/proj/dep.ts"],
		});
		expect(out[0].message).toContain("alice recently read dep.ts");
		expect(out[0].message).toContain("These files import from target.ts");
	});

	it("uses empty agent name when event.agent_name is undefined (L30 ?? branch)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		// The editing session has agent_name "" — it should be skipped (L39),
		// while a named other agent fires the warning. This exercises the
		// `event.agent_name || ""` falsy branch.
		const sessions = makeSessions([
			makeSession({ agent_name: "", files_read: ["/proj/dep.ts"] }),
			makeSession({
				agent_name: "bob",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:30Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent(undefined), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		expect(out[0].message).toContain("bob recently read");
		// The empty-name session must have been skipped, not reported.
		expect(out[0].message).not.toContain(" recently read dep.ts; ");
	});

	it("aggregates multiple files per agent and adds a +N overflow (L68-69 ternary true)", () => {
		const deps = ["/proj/a.ts", "/proj/b.ts", "/proj/c.ts", "/proj/d.ts", "/proj/e.ts"];
		const graph = makeGraph({ dependents: deps });
		const sessions = makeSessions([
			makeSession({
				agent_name: "carol",
				files_read: deps,
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		// First 3 listed, then " +2" overflow.
		expect(out[0].message).toContain("carol recently read a.ts, b.ts, c.ts +2");
	});

	it("does not add overflow when an agent read 3 or fewer deps (L69 ternary false)", () => {
		const deps = ["/proj/a.ts", "/proj/b.ts", "/proj/c.ts"];
		const graph = makeGraph({ dependents: deps });
		const sessions = makeSessions([
			makeSession({
				agent_name: "dan",
				files_read: deps,
				started_at: "2026-06-05T00:59:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out[0].message).toContain("dan recently read a.ts, b.ts, c.ts.");
		expect(out[0].message).not.toContain("+");
	});

	it("dedups two distinct agents into separate summaries (byAgent map, L67 multi-key)", () => {
		const graph = makeGraph({ dependents: ["/proj/dep.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "alice",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
			makeSession({
				agent_name: "bob",
				files_read: ["/proj/dep.ts"],
				started_at: "2026-06-05T00:58:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		expect(out[0].message).toContain("alice recently read dep.ts");
		expect(out[0].message).toContain("bob recently read dep.ts");
		// Two summaries joined by "; ".
		expect(out[0].message).toContain("; ");
	});

	it("merges two sessions of the SAME agent into one summary (L61 `|| []` existing-array branch)", () => {
		const graph = makeGraph({ dependents: ["/proj/a.ts", "/proj/b.ts"] });
		const sessions = makeSessions([
			makeSession({
				agent_name: "eve",
				files_read: ["/proj/a.ts"],
				started_at: "2026-06-05T00:59:00Z",
			}),
			makeSession({
				agent_name: "eve",
				files_read: ["/proj/b.ts"],
				started_at: "2026-06-05T00:58:00Z",
			}),
		]);
		const out = checkCoDependencyStaleness(FILE, REL, makeEvent("me"), graph, sessions, 3600);
		expect(out).toHaveLength(1);
		// Single "eve" summary listing both files (proves the `|| []` reused the
		// existing array on the second push for the same agent key).
		const eveCount = (out[0].message.match(/eve recently read/g) || []).length;
		expect(eveCount).toBe(1);
		expect(out[0].message).toContain("eve recently read a.ts, b.ts");
	});
});

// ============================================================================
// checkJSDocParamMismatch
// ============================================================================

describe("checkJSDocParamMismatch", () => {
	const FILE = "/proj/foo.ts";
	const REL = "foo.ts";

	it("returns [] for non-JS/TS extensions without reading the file (L95 guard)", () => {
		const out = checkJSDocParamMismatch("/proj/readme.md", "readme.md");
		expect(out).toEqual([]);
		expect(mockReadFileSync).not.toHaveBeenCalled();
	});

	it.each([".ts", ".tsx", ".js", ".jsx"])(
		"reads the file for supported extension %s",
		(ext) => {
			mockReadFileSync.mockReturnValue("const x = 1;\n");
			const out = checkJSDocParamMismatch(`/proj/foo${ext}`, `foo${ext}`);
			expect(out).toEqual([]);
			expect(mockReadFileSync).toHaveBeenCalledTimes(1);
		},
	);

	it("returns [] when readFileSync throws (L100 catch)", () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toEqual([]);
	});

	it("flags a JSDoc @param name that is not an actual parameter (happy path)", () => {
		// @param "oldName" doesn't appear in (name, age).
		const src = [
			"/**",
			" * Greet someone.",
			" * @param {string} oldName - mismatched",
			" * @param age - matches",
			" */",
			"function greet(name, age) {",
			"  return name;",
			"}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "jsdoc_param_mismatch",
			severity: "warning",
			file: FILE,
		});
		expect(out[0].message).toContain('JSDoc @param "oldName"');
		expect(out[0].message).toContain("[name, age]");
		expect(out[0].message).toContain("foo.ts:6");
	});

	it("does not flag when every @param matches the parameters (L154 false)", () => {
		const src = [
			"/**",
			" * @param name",
			" * @param age",
			" */",
			"function greet(name, age) {",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("skips lines that are not function declarations (L112 continue)", () => {
		mockReadFileSync.mockReturnValue("const a = 1;\nlet b = 2;\n");
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("skips a function with an empty parameter list (L116 !paramStr.trim continue)", () => {
		const src = ["/**", " * @param ghost", " */", "function noargs() {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		// noargs() has paramStr "" -> trimmed empty -> continue before JSDoc scan.
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("skips when param parsing yields no names after destructure filtering (L129 continue)", () => {
		// `{ }` -> split/filter drops "{" and "}" leaving zero param names.
		// We reach a match via `foo(( ... ))` shape so funcMatch[1] is "{ }".
		const src = ["/**", " * @param phantom", " */", "wrap(({ }) => {})"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("returns [] when a matching function has no preceding JSDoc (L150 continue)", () => {
		mockReadFileSync.mockReturnValue("function greet(name, age) {\n  return name;\n}\n");
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("stops the backward scan at the /** opener (L139 break)", () => {
		// The @param above the /** line must NOT be collected: the loop breaks
		// at "/**". Here the only @param is inside the block, and it matches,
		// so no finding — and a stray @param ABOVE the opener is ignored.
		const src = [
			" * @param strayAbove",
			"/**",
			" * @param name",
			" */",
			"function greet(name) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		// strayAbove would mismatch if collected; it must not be.
		expect(out).toEqual([]);
	});

	it("stops the backward scan at a non-comment, non-blank line (L141-147 break)", () => {
		// An intervening code statement between a stray @param and the function
		// halts the scan, so the stray @param is never gathered.
		const src = [
			" * @param strayBlocked",
			"const SEPARATOR = 1;",
			"function greet(name) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("allows blank lines and // comments inside the backward scan (L141-147 continue path)", () => {
		// Blank line + // line do NOT break the scan, so the mismatched @param
		// above them is collected and fires.
		const src = [
			" * @param mismatchHere",
			"//",
			"",
			"function greet(name) {}",
		].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(out[0].message).toContain('"mismatchHere"');
	});

	it("caps the backward scan ~30 lines above the function (L133 Math.max bound)", () => {
		// A mismatched @param 40 lines above is out of the 30-line window;
		// the comment chain is unbroken (all blank), so the only thing that
		// could fire is out of range -> no finding.
		const lines: string[] = [" * @param wayUp"];
		for (let i = 0; i < 40; i++) lines.push("");
		lines.push("function greet(name) {}");
		mockReadFileSync.mockReturnValue(lines.join("\n"));
		expect(checkJSDocParamMismatch(FILE, REL)).toEqual([]);
	});

	it("caps output at 5 findings (L163 break)", () => {
		// Build 7 mismatched function+JSDoc blocks; only 5 should be reported.
		const block = (n: number) =>
			["/**", ` * @param wrong${n}`, " */", `function fn${n}(real${n}) {}`].join("\n");
		const src = Array.from({ length: 7 }, (_, i) => block(i)).join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(5);
		expect(out.every((r) => r.check === "jsdoc_param_mismatch")).toBe(true);
	});

	it("matches @param tags without a {type} prefix (regex optional group)", () => {
		const src = ["/**", " * @param typeless", " */", "function greet(name) {}"].join("\n");
		mockReadFileSync.mockReturnValue(src);
		const out = checkJSDocParamMismatch(FILE, REL);
		expect(out).toHaveLength(1);
		expect(out[0].message).toContain('"typeless"');
	});
});

// ============================================================================
// checkInterfaceChangeImpact
// ============================================================================

describe("checkInterfaceChangeImpact", () => {
	const FILE = "/proj/types.ts";
	const REL = "types.ts";

	it("returns [] when no interface bodies changed (L194 guard)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number }"]]), // identical
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toEqual([]);
		// No dependents lookup needed when nothing changed.
		expect(graph.getDependents).not.toHaveBeenCalled();
	});

	it("detects a removed interface (L187 !newBody -> Removed)", () => {
		const oldBodies = new Map([["Gone", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map(), // "Gone" no longer present
			dependents: ["/proj/importer.ts"],
			importers: [edge(["Gone"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(out[0].message).toContain("`Gone`");
		expect(out[0].message).toContain("importer.ts");
	});

	it("detects a modified interface body (L189 oldBody !== newBody -> Modified)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number; b: string }"]]),
			dependents: ["/proj/importer.ts"],
			importers: [edge(["Foo"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "interface_change_impact",
			severity: "warning",
			file: FILE,
			affectedFiles: ["/proj/importer.ts"],
		});
		expect(out[0].message).toContain("Verify implementations are updated");
	});

	it("returns [] when a changed interface has no dependents (L198 guard)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number; b: string }"]]),
			dependents: [], // changed but nothing depends on the file
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toEqual([]);
		// Importers lookup is skipped on the no-dependents path.
		expect(graph.getImporters).not.toHaveBeenCalled();
	});

	it("returns [] when dependents exist but none import a changed symbol (L203 some false -> L209 false)", () => {
		const oldBodies = new Map([["Foo", "{ a: number }"]]);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a: number; b: string }"]]),
			dependents: ["/proj/importer.ts"],
			// importer pulls a DIFFERENT symbol, so usesChanged is false.
			importers: [edge(["Bar"], "/proj/importer.ts")],
		});
		expect(checkInterfaceChangeImpact(FILE, REL, oldBodies, graph)).toEqual([]);
	});

	it("truncates the changed-interface name list past 4 with +N (L211 ternary true)", () => {
		const old = new Map<string, string>();
		for (const n of ["I1", "I2", "I3", "I4", "I5", "I6"]) old.set(n, `{ ${n} }`);
		const graph = makeGraph({
			interfaceBodies: new Map(), // all 6 removed
			dependents: ["/proj/importer.ts"],
			importers: [edge(["I1", "I2", "I3", "I4", "I5", "I6"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, old, graph);
		expect(out).toHaveLength(1);
		// First 4 names listed, then " +2".
		expect(out[0].message).toContain("I1, I2, I3, I4 +2");
	});

	it("does not truncate names at exactly 4 changed interfaces (L211 ternary false)", () => {
		const old = new Map<string, string>();
		for (const n of ["I1", "I2", "I3", "I4"]) old.set(n, `{ ${n} }`);
		const graph = makeGraph({
			interfaceBodies: new Map(),
			dependents: ["/proj/importer.ts"],
			importers: [edge(["I1", "I2", "I3", "I4"], "/proj/importer.ts")],
		});
		const out = checkInterfaceChangeImpact(FILE, REL, old, graph);
		// Names are wrapped in backticks: `I1, I2, I3, I4` with no +N overflow.
		expect(out[0].message).toContain("`I1, I2, I3, I4`");
		expect(out[0].message).not.toContain("+");
	});

	it("truncates the affected-file list past 6 with 'and N more' (L216 ternary true)", () => {
		const oldBodies = new Map([["Foo", "{ a }"]]);
		const importerFiles = Array.from({ length: 8 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a; b }"]]),
			dependents: ["/proj/any.ts"],
			importers: importerFiles.map((f) => edge(["Foo"], f)),
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out).toHaveLength(1);
		// 6 files listed + "and 2 more".
		expect(out[0].message).toContain("and 2 more");
		expect(out[0].affectedFiles).toHaveLength(8);
	});

	it("does not append 'and N more' at exactly 6 affected files (L216 ternary false)", () => {
		const oldBodies = new Map([["Foo", "{ a }"]]);
		const importerFiles = Array.from({ length: 6 }, (_, i) => `/proj/imp${i}.ts`);
		const graph = makeGraph({
			interfaceBodies: new Map([["Foo", "{ a; b }"]]),
			dependents: ["/proj/any.ts"],
			importers: importerFiles.map((f) => edge(["Foo"], f)),
		});
		const out = checkInterfaceChangeImpact(FILE, REL, oldBodies, graph);
		expect(out[0].message).not.toContain("more");
		expect(out[0].affectedFiles).toHaveLength(6);
	});
});

// ============================================================================
// checkTestProximity
// ============================================================================

describe("checkTestProximity", () => {
	it("returns [] when the edited file is itself a .test file (L246 guard)", () => {
		const out = checkTestProximity(
			"/proj/src/foo.test.ts",
			"src/foo.test.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
		expect(mockExistsSync).not.toHaveBeenCalled();
	});

	it("returns [] when the edited file is a .spec file (L246 guard)", () => {
		const out = checkTestProximity(
			"/proj/src/foo.spec.ts",
			"src/foo.spec.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	it("returns [] for a declaration .d.ts file (L248 base.endsWith('.d'))", () => {
		const out = checkTestProximity(
			"/proj/src/foo.d.ts",
			"src/foo.d.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	it("returns [] for an index file (L248 base === 'index')", () => {
		const out = checkTestProximity(
			"/proj/src/index.ts",
			"src/index.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	it.each(["dist/", "node_modules/", ".next/", "build/", ".interlinked/"])(
		"returns [] for generated dir %s (L251-258 guard)",
		(seg) => {
			const rel = `${seg}foo.ts`;
			const out = checkTestProximity(`/proj/${rel}`, rel, makeEvent("me"), makeSessions([]));
			expect(out).toEqual([]);
			expect(mockExistsSync).not.toHaveBeenCalled();
		},
	);

	it("normalizes backslashes before the generated-dir check (L250 replace)", () => {
		// Windows-style relPath with a dist segment must still be skipped.
		const out = checkTestProximity(
			"/proj/dist/foo.ts",
			"dist\\foo.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toEqual([]);
	});

	it("reports an info finding when no test file exists (L270 !testFile)", () => {
		mockExistsSync.mockReturnValue(false);
		const out = checkTestProximity(
			"/proj/src/foo.ts",
			"src/foo.ts",
			makeEvent("me"),
			makeSessions([]),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "test_proximity",
			severity: "info",
			file: "/proj/src/foo.ts",
		});
		expect(out[0].message).toContain("No test file found for src/foo.ts");
		expect(out[0].message).toContain("Consider adding foo.test.ts");
		expect(out[0].affectedFiles).toBeUndefined();
		// All four candidates probed.
		expect(mockExistsSync).toHaveBeenCalledTimes(4);
	});

	it("reports a gentle reminder when test exists but agent hasn't updated it (L283 true)", () => {
		// First candidate (sibling .test.ts) exists.
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([
			makeSession({ agent_name: "me", files_written: ["/proj/src/foo.ts"] }),
		]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			check: "test_proximity",
			severity: "info",
			file: "/proj/src/foo.ts",
			affectedFiles: [testPath],
		});
		expect(out[0].message).toContain("its test file hasn't been updated");
		expect(out[0].message).toContain("Test: foo.test.ts");
	});

	it("stays silent when the agent HAS written the test file this session (L283 false)", () => {
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([
			makeSession({
				agent_name: "me",
				files_written: ["/proj/src/foo.ts", testPath], // test already touched
			}),
		]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toEqual([]);
	});

	it("stays silent when no session matches the editing agent (L282 sess undefined, L283 short-circuit)", () => {
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		// Session belongs to a different agent -> find() returns undefined.
		const sessions = makeSessions([makeSession({ agent_name: "someone-else" })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toEqual([]);
	});

	it("uses empty agent name when event.agent_name is undefined (L281 || '' branch)", () => {
		const testPath = "/proj/src/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		// A session with agent_name "" matches the "" fallback and hasn't
		// written the test -> reminder fires.
		const sessions = makeSessions([makeSession({ agent_name: "" })]);
		const out = checkTestProximity(
			"/proj/src/foo.ts",
			"src/foo.ts",
			makeEvent(undefined),
			sessions,
		);
		expect(out).toHaveLength(1);
		expect(out[0].message).toContain("its test file hasn't been updated");
	});

	it("finds a test in a __tests__ subdir (later candidate in the find() scan)", () => {
		const testPath = "/proj/src/__tests__/foo.test.ts";
		mockExistsSync.mockImplementation((p) => p === testPath);
		const sessions = makeSessions([makeSession({ agent_name: "me" })]);
		const out = checkTestProximity("/proj/src/foo.ts", "src/foo.ts", makeEvent("me"), sessions);
		expect(out).toHaveLength(1);
		expect(out[0].affectedFiles).toEqual([testPath]);
		expect(out[0].message).toContain("Test: foo.test.ts");
	});
});
