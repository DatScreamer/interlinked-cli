// ===========================================
// Manifest key normalization — the ONE canonical path choke point
// ===========================================
// Extracted from manifest.ts (2026-08-16) to break the
// manifest.ts ↔ manifest-heal.ts import cycle: the healer needs only this
// function, and it was the single VALUE edge forcing the cycle — everything
// else the healer pulls from manifest.ts is type-only. Both modules now
// depend downward on this leaf; manifest.ts re-exports for its many existing
// callers.

import { isAbsolute, relative, resolve } from "node:path";
import { normalizeFindingPath } from "../findings/provenance.js";

/**
 * Normalize a raw `file` argument into the manifest's ONE canonical key: a
 * repo-relative, forward-slash path with no leading "./". This is the single
 * choke point every manifest reader/writer funnels a path through —
 * `applyMeasuredRun` and `fileRecords` in manifest.ts, plus accept.ts's
 * `locate` / `withMutant` — so an absolute path, a "./"-prefixed path, and a
 * backslash path all collapse onto the SAME key instead of each earning an
 * independent record.
 *
 * Measured defect (2026-07-31): Claude Code's hook event carries an ABSOLUTE
 * `file_path`, while the brownfield-adoption sweep (`seedFileBaseline`, driven
 * from a plain repo-relative path list) keys the SAME files by their
 * repo-relative path. 17 files ended up with two independent records, so the
 * survivor-diff invariant compared an edit against a record that was not its
 * own — half of every affected file's measurement history was invisible to
 * the ratchet.
 *
 * Reuses `normalizeFindingPath` (findings/provenance.ts) for the string-level
 * cleanup (backslash → "/", strip a leading "./") rather than re-deriving it —
 * `findings/corpus.ts`'s `toRepoRelative` composes the exact same
 * `isAbsolute(file) ? relative(cwd, file) : file` shape for the same reason.
 * `cwd` defaults to `process.cwd()` — the harness's documented convention that
 * every `.interlinked/` path resolves against the process cwd (the guarded
 * repo root) — but real callers on the live gate path (gate.ts /
 * pre-tool-coverage-gates.ts) thread the daemon's actual `ctx.cwd` explicitly,
 * since a daemon started with `--cwd` can diverge from `process.cwd()`.
 */
// interlinked: defer same_typed_primitive_params -- (file, cwd) is the repo-wide documented convention for path helpers; a branded ManifestKey refactor is tracked, not drive-by
export function normalizeManifestKey(file: string, cwd: string = process.cwd()): string {
	const posix = normalizeFindingPath(file);
	// Both branches go through the SAME resolve -> relative round-trip. An earlier
	// version returned a relative input after string cleanup only, which left this
	// "canonical" key non-canonical for exactly the spellings a choke point exists
	// to collapse: measured 2026-07-31, one file produced FIVE distinct keys —
	// `src//a.ts`, `src/./a.ts`, `src/sub/../a.ts` and `../<repo>/src/a.ts` each
	// survived alongside `src/a.ts`. That is the same two-spellings/one-map class
	// this function was introduced to kill, reintroduced inside the fix itself.
	// `resolve` collapses `//`, `/./` and `/../`, so the round-trip is idempotent.
	const abs = isAbsolute(posix) ? posix : resolve(cwd, posix);
	return normalizeFindingPath(relative(cwd, abs));
}
