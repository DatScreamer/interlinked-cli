// procfs-probe — a TEST file using a "/proc/…" path as an "unwritable path"
// fixture.
//
// Bug class (CI-hang, not a wrong answer): a test that wants "a path I cannot
// write to" reaches for `/proc/nonexistent/x`, because /proc is famously
// read-only. On macOS there is no /proc at all, so the fixture behaves like any
// other missing path and the test passes locally. On Linux
// `mkdirSync(p, { recursive: true })` under /proc does NOT throw — it spins
// forever. The vitest worker never returns and the whole lane sits until the
// job timeout.
//
// Verified history in this repo: four such probes across three test files
// (daemon-ledger, stop-nudge-throttle ×2, recurrence ×2) each hung the ubuntu
// unit lane for 25 minutes — CI runs 30410747800, 30412876710, 30466905490 —
// and produced a month-long bogus quarantine of recurrence.test.ts, whose
// "collection hang" was this and nothing else. The mechanism had been written
// down in `src/lib/guard-state.test.ts` since 2026-06 and simply never
// propagated to the files that later copied the idiom. That is precisely the
// kind of knowledge a detector carries and a comment does not.
//
// The safe fixture is a path nested under a regular FILE:
//   const fileAsParent = join(root, "not-a-directory");
//   writeFileSync(fileAsParent, "x");
//   … join(fileAsParent, "nested")   // ENOTDIR, immediately, on every platform
//
// Check id: procfs_probe_in_test. Advisory, `post` phase — the load-bearing
// surface is WRITE TIME (the warning must land while the agent is authoring the
// test, before it can reach CI), and the repo reserves `pre_block` for
// zero-FP deterministic errors.
//
// FP posture. Only a string literal whose ENTIRE VALUE is an absolute procfs
// path counts, so the incidental mentions are excluded structurally rather than
// by guesswork:
//   - comments are masked first, so the hazard comment in guard-state.test.ts
//     ('must NOT use a "/proc/…" path') does not fire the check it documents;
//   - prose containing the word ("the /proc hazard", "process", "/procedures")
//     is not a value that starts with `/proc/`, so it never matches;
//   - a fixture nested inside another literal (`'cwd: "/proc/x"'`, how this
//     check's own tests carry their inputs) has the OUTER value, which does not
//     start with `/proc` — so a test ABOUT procfs paths is not a test that USES
//     one.
// Deliberately NOT distinguished: what the path is passed to. A legitimate
// platform probe that READS a well-known informational procfs file is exempted
// by exact path (INFORMATIONAL_PROCFS_FILES) because that set is closed and
// checkable; every other use — including anything nested BELOW one of those
// files — fires, because the call-site intent is not reliably recoverable from
// a single-file regex scan and a hung CI lane costs more than a warning.

import { type InlineMatch, isStrictTestFile, stripComments } from "./shared.js";

/** Cap on reported probes per file — the first few are enough to act on. */
const MAX_MATCHES = 10;

/**
 * A string literal VALUE that is an absolute procfs path: exactly `/proc` (the
 * `join("/proc", …)` spelling) or anything under `/proc/`. Anchored at both
 * ends of the segment so `/procedures/x` and `/processes` never match.
 */
const PROCFS_PATH_RE = /^\/proc(?:\/|$)/;

/**
 * Single-line quoted literals: `"…"`, `'…'`, `` `…` ``. Group 2 is the value.
 * Escapes are consumed as a unit so `"a\"b"` reads as one literal. Scanning is
 * non-overlapping and left-to-right, which is what makes a nested fixture
 * (`'cwd: "/proc/x"'`) resolve to the OUTER literal.
 */
const QUOTED_LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Well-known informational procfs FILES that tests legitimately read for a
 * platform probe (core count, memory, container detection). Exempt on EXACT
 * match only: `/proc/cpuinfo` is a read, while `/proc/cpuinfo/nested` is a path
 * being used as a directory and is not exempt.
 */
const INFORMATIONAL_PROCFS_FILES: ReadonlySet<string> = new Set([
	"/proc/cpuinfo",
	"/proc/meminfo",
	"/proc/loadavg",
	"/proc/uptime",
	"/proc/stat",
	"/proc/version",
	"/proc/mounts",
	"/proc/net/dev",
	"/proc/self/status",
	"/proc/self/cgroup",
	"/proc/self/mountinfo",
]);

/** Procfs path values used as paths on one comment-masked line, in order. */
function procfsLiteralsOnLine(line: string): string[] {
	const found: string[] = [];
	QUOTED_LITERAL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = QUOTED_LITERAL_RE.exec(line);
	while (m) {
		const value = m[2] ?? "";
		if (PROCFS_PATH_RE.test(value) && !INFORMATIONAL_PROCFS_FILES.has(value)) {
			found.push(value);
		}
		m = QUOTED_LITERAL_RE.exec(line);
	}
	return found;
}

/** The finding text. It IS the guidance the next agent gets, so it names the
 *  mechanism and spells the safe fixture out rather than gesturing at it. */
function probeMessage(value: string, sourceLine: string): string {
	return (
		`[procfs path as a test fixture (${value}) — recursive mkdir under /proc does NOT ` +
		"throw on Linux, it spins forever and hangs the test worker until the CI job times " +
		"out (three 25-minute ubuntu unit-lane hangs, 2026-07). Nest the fixture under a " +
		'regular FILE instead: writeFileSync(f, "x") then join(f, "nested") — that yields ' +
		`ENOTDIR immediately on every platform] ${sourceLine.trim().slice(0, 100)}`
	);
}

/**
 * Flag `/proc/…` path literals in TEST files — the "unwritable path" fixture
 * that hangs Linux CI. One match per literal, capped at `MAX_MATCHES`.
 *
 * check id: `procfs_probe_in_test`
 */
export function detectProcfsProbeInTest(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!content.includes("/proc")) return [];

	const codeLines = stripComments(content).split("\n");
	const sourceLines = content.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < codeLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		for (const value of procfsLiteralsOnLine(codeLines[i] ?? "")) {
			if (matches.length >= MAX_MATCHES) break;
			matches.push({ line: i + 1, text: probeMessage(value, sourceLines[i] ?? "") });
		}
	}
	return matches;
}
