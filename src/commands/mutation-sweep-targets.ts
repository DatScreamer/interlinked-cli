import { join } from "node:path";
import { isTestPath } from "../harness/coverage-test-selector.js";
import { findManifestFiles } from "../harness/manifest-file-walk.js";

/** One file to measure, with the debt that put it on the list. */
export interface SweepTarget {
	file: string;
	open: number;
	uncovered: number;
	/** True when the file's records already carry measurement provenance — it
	 *  has been measured under the current regime, so a re-sweep would re-pay
	 *  for an answer already held. */
	qualified: boolean;
	/** ISO timestamp of the file's current measurement provenance. Null means
	 *  the file is absent from the manifest or carries legacy, unqualified
	 *  records. */
	measuredAt?: string | null;
}

const MUTATION_SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/** The exact full-census domain: JS/TS product source under `src/`. */
export function eligibleMutationFiles(cwd: string): string[] {
	return findManifestFiles(join(cwd, "src"), (name) => MUTATION_SOURCE_EXT.test(name))
		.map((file) => `src/${file}`)
		.filter((file) => !file.endsWith(".d.ts") && !isTestPath(file));
}

/** Merge the current source domain with manifest debt and provenance rows. */
export function mergeEligibleTargets(
	manifestRows: readonly SweepTarget[],
	eligibleFiles: readonly string[],
): SweepTarget[] {
	const byFile = new Map(manifestRows.map((row) => [row.file, row]));
	return eligibleFiles
		.map((file): SweepTarget => {
			const row = byFile.get(file);
			return row ?? { file, open: 0, uncovered: 0, qualified: false, measuredAt: null };
		})
		.sort((a, b) => b.open - a.open || b.uncovered - a.uncovered || a.file.localeCompare(b.file));
}
