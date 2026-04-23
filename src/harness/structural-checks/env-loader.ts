// ===========================================
// .env example loader (used by undefined-env-vars check)
// ===========================================
// Helpers for reading `.env.example` / `.env.sample` / `.env.template`
// files when the undefined_env_vars check wants to compare a file's
// `process.env.FOO` references against documented variables.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Public API — consumed by structural-checks/env-vars.ts.
 *
 * Look for `.env.example`/`.env.sample`/`.env.template` in `dir` and parse it
 * into a Set of declared variable names. Returns null when no such file exists
 * so the caller can walk parent directories.
 */
export function readEnvExampleFromDir(dir: string): Set<string> | null {
	for (const name of [".env.example", ".env.sample", ".env.template"]) {
		const envPath = join(dir, name);
		if (!existsSync(envPath)) continue;
		try {
			const envContent = readFileSync(envPath, "utf-8");
			return parseEnvKeys(envContent);
		} catch (_err) {
			void 0; /* intentional: unreadable env file — return empty Set so caller stops walking */
			return new Set();
		}
	}
	return null;
}

/**
 * Public API — consumed by readEnvExampleFromDir.
 *
 * Parse `.env`-style contents into a Set of declared variable names. Skips
 * comments and blank lines; takes everything before the first `=` as the key.
 */
export function parseEnvKeys(envContent: string): Set<string> {
	const out = new Set<string>();
	for (const line of envContent.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx > 0) out.add(trimmed.slice(0, eqIdx).trim());
	}
	return out;
}
