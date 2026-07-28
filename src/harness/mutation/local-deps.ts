// ===========================================
// Per-edit mutation — carrying uncommitted siblings to the runner
// ===========================================
// A mutation runner works in its OWN checkout, which sits at a commit. The
// overlay mechanism is what makes the agent's uncommitted work visible there.
// Until this module existed, overlays carried only the edited file, the rest of
// the change set, and the companion test — not the edited file's own local
// imports.
//
// That gap made a whole class of edit unmeasurable, and it failed SILENTLY in
// the worst way. Observed live: an edit added an import of a brand-new module,
// the runner's checkout had no such file, the test file failed to load, and
// Stryker reported "No tests were executed" — which reaches the agent as a bland
// "the mutation runner failed". Nothing pointed at the missing file.
//
// The walk is transitive because a new module routinely imports another new
// module, and bounded because a per-edit gate cannot afford to fan out over a
// repository. Only paths that actually resolve on disk are returned: a
// specifier that resolves to nothing here is either a package (already present
// in the runner's node_modules) or genuinely broken, and neither is this
// module's problem to report.

import { dirname, join, normalize } from "node:path";

/** Ceiling on files pulled into one request. Chosen to comfortably cover a
 *  realistic new-module cluster while keeping the payload bounded. */
export const LOCAL_DEP_CAP = 40;

/** Relative specifiers only. Anything else is a package or a builtin, which the
 *  runner's checkout already has. */
const SPECIFIER = /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)["'](\.[^"']*)["']/g;

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Turn one specifier into the repo-relative path of the file it means.
 *
 * TypeScript ESM writes `./x.js` for a file that is `./x.ts` on disk, so the
 * `.js`-to-source rewrite is the common case rather than an edge case.
 */
function resolveSpecifier(fromFile: string, spec: string, read: (p: string) => string | null): string | null {
	const base = normalize(join(dirname(fromFile), spec));
	const candidates = [
		...(/\.[cm]?jsx?$/.test(base) ? EXTENSIONS.map((e) => base.replace(/\.[cm]?jsx?$/, e)) : []),
		base,
		...EXTENSIONS.map((e) => `${base}${e}`),
		...EXTENSIONS.map((e) => join(base, `index${e}`)),
	];
	for (const c of candidates) {
		if (read(c) !== null) return c;
	}
	return null;
}

/** Every relative specifier appearing in a source file, in source order. */
function specifiersIn(content: string): string[] {
	const out: string[] = [];
	for (const m of content.matchAll(SPECIFIER)) {
		if (m[1]) out.push(m[1]);
	}
	return out;
}

/**
 * Repo-relative paths the entry file depends on locally, transitively.
 *
 * Excludes the entry itself — the caller already overlays that with the
 * PROPOSED content, and re-adding it from disk would overwrite the very edit
 * being measured.
 */
export function collectLocalDeps(
	entry: string,
	read: (path: string) => string | null,
	cap: number = LOCAL_DEP_CAP,
): string[] {
	const found: string[] = [];
	const seen = new Set<string>([entry]);
	const queue: string[] = [entry];

	while (queue.length > 0 && found.length < cap) {
		const current = queue.shift();
		if (current === undefined) break;
		const content = read(current);
		if (content === null) continue;
		for (const spec of specifiersIn(content)) {
			if (found.length >= cap) break;
			const resolved = resolveSpecifier(current, spec, read);
			if (resolved === null || seen.has(resolved)) continue;
			seen.add(resolved);
			found.push(resolved);
			queue.push(resolved);
		}
	}
	return found;
}
