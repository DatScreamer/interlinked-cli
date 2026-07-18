// ===========================================
// Coverage pairing — source↔test pair derivation (pure leaf)
// ===========================================
// The filename conventions that make two paths "the same coverage pair":
// stem match (`src/foo.ts` ↔ `src/foo.test.ts`), the `__tests__/` umbrella,
// and the decomposed-sibling prefix rule. Extracted verbatim from
// `coverage-debt.ts` (2026-07-17, line-cap decomposition); that module
// re-exports the public names so existing consumers keep their import path.
// Deliberately dependency-free — the debt rule, its message renderers, and
// the gate glue all import from here without cycle risk.

/** The `.test`/`.spec` infix marker, shared by every debt surface that needs
 *  to know whether a path IS the test side of a pair (role-correct message
 *  phrasing, optimistic recheck scoping). Exported so sibling modules never
 *  drift from the pairing convention with a hand-rolled copy. */
export const TEST_INFIX_RX = /\.(test|spec)\.[cm]?[jt]sx?$/i;

const CODE_EXT_RX = /\.[cm]?[jt]sx?$/i;

/**
 * The logical-unit key shared by a source file and its co-located test: strip a
 * `.test`/`.spec` infix and the extension. `src/foo.ts` and `src/foo.test.ts`
 * both map to `src/foo`; `src/bar.ts` does not. Two edits are "in the same pair"
 * iff they share a stem.
 */
export function pairStem(relPath: string): string {
	return relPath.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, "").replace(/\.[cm]?[jt]sx?$/i, "");
}

/** Split a path into (directory, basename-stem, isTest). A trailing `/__tests__`
 *  segment is stripped from the directory so an umbrella test under `__tests__/`
 *  resolves to the same directory as the sources it covers. */
function pairParts(relPath: string): { dir: string; stem: string; isTest: boolean } {
	const isTest = TEST_INFIX_RX.test(relPath);
	const noInfix = relPath.replace(TEST_INFIX_RX, "").replace(CODE_EXT_RX, "");
	const slash = noInfix.lastIndexOf("/");
	const dir = (slash >= 0 ? noInfix.slice(0, slash) : "").replace(/\/__tests__$/, "");
	const stem = slash >= 0 ? noInfix.slice(slash + 1) : noInfix;
	return { dir, stem, isTest };
}

/**
 * True iff two paths belong to the same coverage pair. Beyond the exact stem
 * match (`src/foo.ts` ↔ `src/foo.test.ts`), this also pairs a DECOMPOSED source
 * with its UMBRELLA test: `foo-bar.ts` is covered by `foo.test.ts` when they
 * share a directory (or the test lives in that directory's `__tests__/`) and the
 * test's stem is a hyphen-delimited prefix of the source's stem. Decomposing
 * `foo.ts` into `foo-*.ts` siblings otherwise stranded each from the umbrella
 * test that exercises it (`__tests__/write-content-guards.test.ts` no longer
 * paired with `write-content-guards-content-quality.ts`). Optimistic by the same
 * contract as the rest of debt mode — the commit gate is the ground-truth backstop.
 */
export function inSamePair(a: string, b: string): boolean {
	if (pairStem(a) === pairStem(b)) return true;
	const pa = pairParts(a);
	const pb = pairParts(b);
	if (pa.dir !== pb.dir) return false;
	// Exactly one side must be a test; its stem prefixes the source side's stem.
	const test = pa.isTest && !pb.isTest ? pa : pb.isTest && !pa.isTest ? pb : null;
	const src = test === pa ? pb : test === pb ? pa : null;
	if (!test || !src) return false;
	return src.stem.startsWith(`${test.stem}-`);
}

/** The conventional co-located test path for a source file (`src/foo.ts` →
 *  `src/foo.test.ts`) — named in the block message so the agent knows where to go. */
export function expectedCompanionTest(source: string): string {
	return source.replace(/\.([cm]?[jt]sx?)$/i, ".test.$1");
}

/** The source counterpart of a TEST path (`src/foo.test.ts` → `src/foo.ts`):
 *  strip the `.test`/`.spec` infix, keep the extension. The inverse of
 *  {@link expectedCompanionTest}, used so a debt opened ON a test file (the
 *  red→green loop's canonical first edit) names its pair correctly instead of
 *  deriving nonsense like `foo.test.test.ts`. */
export function expectedSourceOfTest(testPath: string): string {
	return testPath.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/i, "$2");
}
