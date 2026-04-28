// Canonical-examples fixture for `ubs_unsafe_format_string`.
//
// printf-family format-string position varies by function:
//   printf(fmt)               — slot 1
//   fprintf(stream, fmt)      — slot 2
//   sprintf(buf, fmt)         — slot 2
//   snprintf(buf, n, fmt)     — slot 3 (slot 2 is size)
//
// The reviewer-surfaced gap was misclassifying `snprintf` against
// `sprintf`'s slot-2 regex, flagging the size argument as a tainted
// format. Each per-function shape now has explicit fixture rows so a
// future regex tweak can't silently re-introduce the bug.

import { describe } from "vitest";
import { checkUnsafeFormatString } from "../ubs-language-specific.js";
import { type FixtureRow, runDetectorFixtures } from "./run-fixtures.js";

const FIXTURES: FixtureRow[] = [
	// --- printf (1-arg form): format is slot 1 ---
	{
		input: "void log(const char* fmt) {\n  printf(fmt);\n}\n",
		filePath: "src/foo.c",
		shouldFire: true,
		note: "printf(fmt) — non-literal format in slot 1",
	},
	{
		input: 'printf("hello");',
		filePath: "src/foo.c",
		shouldFire: false,
		note: 'printf("hello") — literal format',
	},
	// --- sprintf (2-arg): format is slot 2 ---
	{
		input: "char buf[64];\nsprintf(buf, fmt);\n",
		filePath: "src/foo.c",
		shouldFire: true,
		note: "sprintf(buf, fmt) — non-literal format in slot 2",
	},
	{
		input: 'char buf[64];\nsprintf(buf, "%s", input);\n',
		filePath: "src/foo.c",
		shouldFire: false,
		note: 'sprintf(buf, "%s", input) — literal format',
	},
	// --- fprintf (2-arg): format is slot 2 ---
	{
		input: "fprintf(stderr, msg);",
		filePath: "src/foo.c",
		shouldFire: true,
		note: "fprintf(stderr, msg) — non-literal format in slot 2",
	},
	// --- snprintf (3-arg): format is slot 3, size is slot 2 ---
	// Reviewer-flagged variants from this PR.
	{
		input: 'char buf[64];\nsnprintf(buf, n, "%s", input);',
		filePath: "src/foo.c",
		shouldFire: false,
		note: 'snprintf(buf, n, "%s", input) — n is size, format is literal in slot 3',
	},
	{
		input: 'char buf[64];\nsnprintf(buf, sizeof(buf), "hello %d", x);',
		filePath: "src/foo.c",
		shouldFire: false,
		note: 'snprintf(buf, sizeof(buf), "...", x) — literal format',
	},
	{
		input: "char buf[64];\nsnprintf(buf, n, fmt);",
		filePath: "src/foo.c",
		shouldFire: true,
		note: "snprintf(buf, n, fmt) — non-literal format in slot 3",
	},
	// --- Language gating ---
	{
		input: "printf(fmt)",
		filePath: "src/foo.py",
		shouldFire: false,
		note: "Python: detector should not fire on .py files",
	},
];

describe("ubs_unsafe_format_string fixtures (canonical examples)", () => {
	runDetectorFixtures(checkUnsafeFormatString, FIXTURES);
});
