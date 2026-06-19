// ===========================================
// License policy — SPDX allowlist for supply-chain admission
// ===========================================
//
// Companion to the package allowlist: a committed list of acceptable SPDX
// license identifiers, evaluated when a package is approved (`interlinked
// allowlist add`) and re-checked per-edit from the *recorded* license field
// (manifest-edit-guard) — the hook path never touches the network.
//
// The default seed mirrors the permissive set cargo-deny configs converge on
// (observed verbatim in sondera-coding-agent-hooks' deny.toml — see
// docs/external-pulse/sondera-coding-agent-hooks.md). Projects override it
// via the `license_allowlist` array in .interlinked/package-allowlist.json.

/** Default permissive-license seed. Override per-project via the
 *  `license_allowlist` field of .interlinked/package-allowlist.json. */
export const DEFAULT_LICENSE_ALLOWLIST: readonly string[] = [
	"MIT",
	"Apache-2.0",
	"Apache-2.0 WITH LLVM-exception",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"BSL-1.0",
	"ISC",
	"Unlicense",
	"Zlib",
	"0BSD",
	"CC0-1.0",
	"MIT-0",
	"MPL-2.0",
	"Unicode-3.0",
	"CDLA-Permissive-2.0",
];

/**
 * Evaluate an SPDX license expression against an allowlist.
 *
 * Deliberately NOT a full SPDX expression engine. Supported, case-insensitively:
 *   - exact identifiers, including `WITH` exceptions ("Apache-2.0 WITH LLVM-exception")
 *   - top-level `OR` — allowed when ANY disjunct is allowed (dual-licensing)
 *   - top-level `AND` — allowed only when ALL conjuncts are allowed
 *
 * Anything beyond that — parenthesized sub-expressions, `+` ranges — returns
 * false (conservative: a complex expression needs a human's `--force`, not a
 * partial parser's guess). Empty/whitespace input is likewise not allowed.
 */
export function isLicenseAllowed(expression: string, allowlist: readonly string[]): boolean {
	const expr = expression.trim();
	if (!expr) return false;
	// Complex shapes we don't evaluate: fail toward "ask the human".
	if (expr.includes("(") || expr.includes(")") || /\+\s*($|\s)/.test(expr)) return false;

	const allowed = new Set(allowlist.map((id) => id.trim().toLowerCase()));
	const idAllowed = (id: string): boolean => allowed.has(id.trim().toLowerCase());

	// OR binds looser than AND in SPDX: any OR-disjunct passing is enough,
	// and within a disjunct every AND-conjunct must pass.
	return expr.split(/\s+OR\s+/i).some((disjunct) => {
		const conjuncts = disjunct.split(/\s+AND\s+/i);
		return conjuncts.length > 0 && conjuncts.every((c) => c.trim() !== "" && idAllowed(c));
	});
}
