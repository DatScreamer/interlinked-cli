// ===========================================
// Harness server CLI-argument helpers
// ===========================================
// Extracted from server.ts. Pure parsing/narrowing of the daemon's
// command-line flags. No module-level state, no I/O — every function is a
// total mapping from its inputs, which makes the daemon's CLI contract
// directly unit-testable.

import type { HarnessProtocolMode } from "./protocol-status.js";

/** Narrow a `parseArgs` string option, which returns `string | true |
 *  undefined`. The `true` case occurs when a string flag is passed bare
 *  (e.g. `--socket` with no `=path`); treat it as "not provided". */
export function stringArg(val: string | boolean | undefined): string | undefined {
	return typeof val === "string" ? val : undefined;
}

/** Resolve the `--protocol` flag to a {@link HarnessProtocolMode}. Anything
 *  other than the three known modes (including absent / malformed) falls back
 *  to `"dual"`, which serves both the raw and framed sockets. */
export function parseProtocolMode(raw: string | undefined): HarnessProtocolMode {
	if (raw === "raw" || raw === "framed" || raw === "dual") return raw;
	return "dual";
}

/** Resolve the effective idle-timeout (ms) from the raw `--idle-timeout`
 *  flag. Absent → `defaultMs` (0 = disabled). A present-but-unparseable
 *  value yields `NaN`, matching the prior `Number(...)` behavior — callers
 *  treat any falsy result as "disabled". */
export function resolveIdleTimeoutMs(
	raw: string | undefined,
	defaultMs: number,
): number {
	return raw !== undefined ? Number(raw) : defaultMs;
}
