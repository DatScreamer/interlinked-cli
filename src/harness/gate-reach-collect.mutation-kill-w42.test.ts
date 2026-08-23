import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	collectGateReachSnapshot,
	enumerateEligibleFiles,
	GATE_REACH_LEDGER_REL,
	readLatestGateReachSnapshot,
	recordGateReach,
} from "./gate-reach-collect.js";
import type { GateReachSnapshot } from "./gate-reach.js";

const READ_TAIL_BYTES = 64 * 1024;

let dirs: string[] = [];

function makeDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "gate-reach-collect-w42-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	dirs = [];
});

function validSnapshotLine(sessionId: string): string {
	const snapshot: GateReachSnapshot = {
		version: 1,
		at: "2026-01-01T00:00:00.000Z",
		session_id: sessionId,
		gates: [],
	};
	return JSON.stringify(snapshot);
}

// -------------------------------------------------------------------------
// readHeader / closeSync fd-hygiene — mutants 94ef5d44, 7a44d637, de9a454c,
// 93c8656c, e3d362cd, b941991c all remove or defeat the `closeSync(fd)` call
// inside readHeader's finally block. Every one of these leaks an open file
// descriptor per file read. enumerateEligibleFiles opens one fd per
// candidate file, so calling it over many files with the real closeSync
// intact should leave the process's open-fd count roughly where it started;
// with the close defeated, the count grows by ~1 per file and never comes
// back down (readHeader never re-closes them later).
// -------------------------------------------------------------------------
describe("readHeader closes its file descriptor (fd-leak detector)", () => {
	it("does not accumulate open file descriptors across many reads", () => {
		const dir = makeDir();
		const fileCount = 250;
		for (let i = 0; i < fileCount; i++) {
			writeFileSync(join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
		}

		const countOpenFds = (): number => {
			try {
				const out = execFileSync("lsof", ["-p", String(process.pid)], { encoding: "utf-8" });
				return out.split("\n").filter((l) => l.includes(dir)).length;
			} catch {
				return -1;
			}
		};

		const before = countOpenFds();
		if (before < 0) {
			// lsof unavailable in this environment — skip rather than false-fail.
			return;
		}

		enumerateEligibleFiles(dir);

		const after = countOpenFds();
		// With closeSync intact, no fd for a file under `dir` should still be
		// open once enumerateEligibleFiles has returned.
		expect(after).toBeLessThan(fileCount);
		expect(after - before).toBeLessThan(10);
	});
});

// -------------------------------------------------------------------------
// parseSnapshotLine — mutant cb98885d disables the session_id type check.
// -------------------------------------------------------------------------
describe("readLatestGateReachSnapshot rejects a non-string session_id", () => {
	it("returns null when the recorded row's session_id is a number, not a string", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const ledger = join(dir, GATE_REACH_LEDGER_REL);
		const badRow = JSON.stringify({
			version: 1,
			at: "2026-01-01T00:00:00.000Z",
			session_id: 42,
			gates: [],
		});
		writeFileSync(ledger, `${badRow}\n`);

		expect(readLatestGateReachSnapshot(dir)).toBeNull();
	});

	it("accepts a row whose session_id is a real string (control)", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const ledger = join(dir, GATE_REACH_LEDGER_REL);
		writeFileSync(ledger, `${validSnapshotLine("sess-ok")}\n`);

		const result = readLatestGateReachSnapshot(dir);
		expect(result?.session_id).toBe("sess-ok");
	});
});

// -------------------------------------------------------------------------
// readLatestGateReachSnapshot tail-truncation gate — mutants 5862979 (force
// the `size > READ_TAIL_BYTES` comparison to always-true) and dca3e167
// (flip it to `<=`) both make the function shift() away the file's own
// first line even when the file is small and no truncation is warranted.
// If the only valid snapshot sits on that first line, the mutated code
// loses it.
// -------------------------------------------------------------------------
describe("small ledger file is not torn-line-shifted", () => {
	it("finds a valid snapshot on the very first line when the file is well under the tail bound", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const ledger = join(dir, GATE_REACH_LEDGER_REL);
		// First line is the only valid snapshot; second line is garbage. File
		// size is tiny (nowhere near READ_TAIL_BYTES), so the real code must
		// NOT shift the first line away.
		writeFileSync(ledger, `${validSnapshotLine("front-line-session")}\nnot-json-garbage\n`);

		const result = readLatestGateReachSnapshot(dir);
		expect(result?.session_id).toBe("front-line-session");
	});
});

// -------------------------------------------------------------------------
// mutant c9cd3258 flips `size > READ_TAIL_BYTES` to `size >= READ_TAIL_BYTES`
// for the shift-guard. At an EXACT boundary (size === READ_TAIL_BYTES) the
// real code must NOT shift (not strictly greater), so the front line must
// still be found; the `>=` mutant wrongly shifts it away.
// -------------------------------------------------------------------------
describe("ledger file exactly at the tail-byte boundary", () => {
	it("still finds the front-line snapshot when size === READ_TAIL_BYTES exactly", () => {
		const dir = makeDir();
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const ledger = join(dir, GATE_REACH_LEDGER_REL);

		const front = validSnapshotLine("boundary-session");
		const prefix = `${front}\n`;
		const padLen = READ_TAIL_BYTES - Buffer.byteLength(prefix, "utf-8");
		expect(padLen).toBeGreaterThan(0);
		const padding = "x".repeat(padLen);
		const content = prefix + padding;
		expect(Buffer.byteLength(content, "utf-8")).toBe(READ_TAIL_BYTES);

		writeFileSync(ledger, content);

		const result = readLatestGateReachSnapshot(dir);
		expect(result?.session_id).toBe("boundary-session");
	});
});

// -------------------------------------------------------------------------
// recordGateReach + readLatestGateReachSnapshot round trip, used as a
// sanity control for the above (also exercises recordGateReach directly).
// -------------------------------------------------------------------------
describe("recordGateReach / readLatestGateReachSnapshot round trip", () => {
	it("reads back exactly what was recorded", () => {
		const dir = makeDir();
		const snapshot: GateReachSnapshot = {
			version: 1,
			at: "2026-02-02T00:00:00.000Z",
			session_id: "round-trip",
			gates: [],
		};
		recordGateReach(dir, snapshot);
		const result = readLatestGateReachSnapshot(dir);
		expect(result?.session_id).toBe("round-trip");
		expect(existsSync(join(dir, GATE_REACH_LEDGER_REL))).toBe(true);
	});
});

// -------------------------------------------------------------------------
// coverageRatchetInput — mutant b9b52caa replaces the "no baseline" reason
// string with "".
// -------------------------------------------------------------------------
describe("collectGateReachSnapshot: missing coverage baseline reason text", () => {
	it("reports the exact 'no .interlinked/coverage-baseline.json' reason", () => {
		const dir = makeDir();
		writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");

		const snapshot = collectGateReachSnapshot({
			cwd: dir,
			sessionId: "s1",
			now: 1700000000000,
			perEditCoverageEnabled: false,
		});
		const gate = snapshot.gates.find((g) => g.gate === "coverage_ratchet");
		expect(gate?.reason).toBe("no_.interlinked/coverage-baseline.json");
	});
});

// -------------------------------------------------------------------------
// coverageRatchetInput — mutant ac9403ba replaces `.replace(/\\/g, "/")`'s
// target string "/" with "". A baseline recorded with a backslash-separated
// path (Windows-style) must normalize to match a POSIX-relative eligible
// path; with "" instead of "/" the backslash is deleted rather than
// converted, so the two paths never match and the file counts unmeasured.
// -------------------------------------------------------------------------
describe("collectGateReachSnapshot: backslash path normalization in the baseline", () => {
	it("counts a backslash-keyed baseline entry as measured for the matching forward-slash file", () => {
		const dir = makeDir();
		mkdirSync(join(dir, "sub"), { recursive: true });
		writeFileSync(join(dir, "sub", "b.ts"), "export const b = 1;\n");
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01T00:00:00.000Z",
				files: {
					"sub\\b.ts": { lines_pct: 100, branches_pct: 100 },
				},
			}),
		);

		const snapshot = collectGateReachSnapshot({
			cwd: dir,
			sessionId: "s1",
			now: 1700000000000,
			perEditCoverageEnabled: false,
		});
		const gate = snapshot.gates.find((g) => g.gate === "coverage_ratchet");
		expect(gate?.measured).toBe(1);
	});
});

// -------------------------------------------------------------------------
// collectGateReachSnapshot — mutant 2f24fd5d replaces the empty-domain
// `[]` inputs array with `["Stryker was here"]`. When there is no eligible
// product code at all, the resulting snapshot must report zero gates.
// -------------------------------------------------------------------------
describe("collectGateReachSnapshot with no eligible files at all", () => {
	it("reports an empty gates array when the walk finds no product code", () => {
		const dir = makeDir();
		// Only a non-code file — no candidates for the JS/TS extension filter.
		writeFileSync(join(dir, "README.md"), "# nothing here\n");

		const snapshot = collectGateReachSnapshot({
			cwd: dir,
			sessionId: "s1",
			now: 1700000000000,
			perEditCoverageEnabled: false,
		});
		expect(snapshot.gates).toEqual([]);
	});
});

// -------------------------------------------------------------------------
// CODE_EXT_RE — mutant 8a28d4f8 drops the trailing `$` anchor, so an
// extension no longer needs to be at the END of the filename to match.
// -------------------------------------------------------------------------
describe("enumerateEligibleFiles extension matching is anchored at end-of-name", () => {
	it("does not treat a file whose name merely CONTAINS '.tsx' as a code candidate", () => {
		const dir = makeDir();
		// ".tsx" appears mid-name but the file does not end in a code extension.
		writeFileSync(join(dir, "notes.tsx.md"), "export const z = 1;\n");
		writeFileSync(join(dir, "real.ts"), "export const real = 1;\n");

		const eligible = enumerateEligibleFiles(dir);
		expect(eligible).toContain("real.ts");
		expect(eligible).not.toContain("notes.tsx.md");
	});
});

// Silence unused-import lint for openSync/closeSync/appendFileSync in case a
// future edit trims a describe block above; kept for parity with the source
// module's own imports used in constructing fixtures directly if needed.
void openSync;
void closeSync;
void appendFileSync;
