// ===========================================
// Package version-range floor — the in-range version the supply-chain screens inspect
// ===========================================
// `interlinked allowlist add --version-range <range>` approves a release range;
// the license + advisory screens must inspect a CONCRETE version the range
// actually ADMITS. The naive "first version literal in the string" grabbed an
// exclusive UPPER bound for upper-bounded ranges (`<2.0.0` → `2.0.0`, a release
// the range FORBIDS), so a clean screen there would vouch for the in-range
// versions it never looked at (finding 2026-06, round 8). It also missed the
// real floor of `>=1 <2.0.0` (a bare `1` didn't match the `\d+\.\d+` literal, so
// it again grabbed the upper `2.0.0`).
//
// This module resolves the range's LOWER bound (resolution floor) instead — the
// minimum version an install resolves at, which is in range — and returns null
// when the range has no lower bound (pure upper-bounded `<2.0.0`, `*`, a
// dist-tag) so the caller falls back to the registry latest with a LOUD note.
// Pure functions, no I/O — directly unit-tested and reusable by harness checks.

/** A numeric-core version literal anchored at the start of a token:
 *  an optional Go-style `v` prefix, then major[.minor[.patch]] plus an optional
 *  `-prerelease` / `+build` suffix. Deliberately LOOSER than strict semver — a
 *  bare major (`1`) or `1.2` is a valid floor token (`>=1`, `~1.2`), which the
 *  old `\d+\.\d+` rule dropped. The leading `v?` is REQUIRED for Go module pins
 *  (`v0.9.1`): without it the literal didn't match, resolveScreenVersion returned
 *  null, and Go (which has no queryable registry-version API) then had no version
 *  to feed OSV — silently SKIPPING the advisory screen on a pinned, possibly
 *  vulnerable module (finding 2026-06). The prefix is preserved through to the
 *  screened version because OSV's `Go` ecosystem expects the `v`-prefixed form. */
import { nonNull } from "../lib/non-null.js";

const FLOOR_LITERAL_RE = /^[vV]?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?/;

/** Leading range comparator, longest-first so `>=`/`<=`/`==`/`~=` win over the
 *  single-char prefixes they start with. */
const RANGE_OP_RE = /^(?:>=|<=|==|~=|\^|~|>|<|=)/;

/** Pad a partial numeric core to major.minor.patch, preserving any Go `v`
 *  prefix and prerelease/build suffix so OSV / registry lookups get a concrete
 *  version: `1` → `1.0.0`, `1.2` → `1.2.0`, `1.2.3-rc.1` / `1.2.3` → unchanged,
 *  `v0.9.1` → `v0.9.1` (prefix kept — OSV's `Go` ecosystem expects it). */
function normalizeVersionLiteral(lit: string): string {
	const m = lit.match(/^([vV]?)(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/);
	if (!m) return lit;
	const [, vPrefix, major, minor, patch, suffix] = m;
	return `${vPrefix}${major}.${minor ?? "0"}.${patch ?? "0"}${suffix ?? ""}`;
}

/**
 * The concrete version the admission screens inspect for a `--version-range`
 * approval: the range's LOWER BOUND (resolution floor), normalized to a full
 * `major.minor.patch`. The screened version is always INSIDE the approved
 * range — an exclusive UPPER bound (`<2.0.0` → `2.0.0`) is never selected,
 * because a clean result on a forbidden release would silently vouch for the
 * in-range versions it never screened (finding 2026-06, round 8).
 *
 * Returns null when the range has no lower bound at all (pure upper-bounded
 * `<2.0.0` / `<=2.0.0`, `*`, dist-tags) — the caller falls back to the registry
 * latest with a LOUD note rather than screening a version the range excludes.
 * An exclusive lower bound (`>1.2.3`) screens its boundary literal: that errs
 * toward the OLDEST admissible version (the conservative, over-reporting choice
 * for a security screen), never toward a forbidden newer release.
 */
export function resolveScreenVersion(range: string): string | null {
	// An npm hyphen range ("1.2.3 - 2.3.4") floors at its left endpoint.
	const hyphen = range.match(/^\s*([vV]?\d[0-9A-Za-z.+-]*)\s+-\s+[vV]?\d/);
	if (hyphen) return normalizeVersionLiteral(nonNull(hyphen[1]));
	// Otherwise scan the comparator clauses (whitespace- or comma-separated; pip
	// uses commas) and take the first LOWER-bound / exact literal. A `<` / `<=`
	// clause is an UPPER bound — its literal sits at or past the excluded edge,
	// so it is never the screened version.
	for (const clause of range.split(/[\s,]+/)) {
		if (clause.length === 0) continue;
		const op = clause.match(RANGE_OP_RE)?.[0] ?? "";
		if (op === "<" || op === "<=") continue;
		const lit = clause.slice(op.length).match(FLOOR_LITERAL_RE);
		if (lit) return normalizeVersionLiteral(lit[0]);
	}
	return null;
}
