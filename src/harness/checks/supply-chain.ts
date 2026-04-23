// Supply-chain / runtime safety checks.
// Extracted from generic-checks.ts.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { getExtension, type InlineMatch, isCliFile, isTestFile, JS_TS_EXTS } from "./shared.js";

// ===========================================
// Supply Chain / Runtime Safety Checks
// ===========================================

/**
 * Detect typosquatted package names in package.json.
 * Compares dependencies against a list of popular npm packages
 * using Levenshtein distance ≤2 to catch near-miss names.
 * e.g., "expresss", "lodashe", "reacr", "axois"
 */
const POPULAR_PACKAGES = new Set([
	"express",
	"react",
	"react-dom",
	"next",
	"vue",
	"angular",
	"lodash",
	"axios",
	"moment",
	"dayjs",
	"chalk",
	"commander",
	"inquirer",
	"yargs",
	"typescript",
	"webpack",
	"vite",
	"esbuild",
	"rollup",
	"parcel",
	"jest",
	"mocha",
	"vitest",
	"cypress",
	"playwright",
	"eslint",
	"prettier",
	"biome",
	"mongoose",
	"sequelize",
	"prisma",
	"knex",
	"typeorm",
	"dotenv",
	"cors",
	"helmet",
	"morgan",
	"body-parser",
	"cookie-parser",
	"jsonwebtoken",
	"bcrypt",
	"bcryptjs",
	"passport",
	"uuid",
	"socket.io",
	"ws",
	"graphql",
	"apollo-server",
	"aws-sdk",
	"firebase",
	"stripe",
	"underscore",
	"ramda",
	"rxjs",
	"zod",
	"joi",
	"yup",
	"debug",
	"winston",
	"pino",
	"bunyan",
	"cheerio",
	"puppeteer",
	"jsdom",
	"crypto-js",
	"node-fetch",
	"got",
	"superagent",
	"ky",
	"fs-extra",
	"glob",
	"minimatch",
	"chokidar",
	"sharp",
	"canvas",
	"jimp",
	"nodemailer",
	"twilio",
	"sendgrid",
	"redis",
	"ioredis",
	"pg",
	"mysql2",
	"sqlite3",
	"better-sqlite3",
	"electron",
	"tauri",
	"tailwindcss",
	"postcss",
	"autoprefixer",
	"sass",
	"less",
	"styled-components",
	"emotion",
	"formik",
	"react-hook-form",
	"react-query",
	"swr",
	"zustand",
	"redux",
	"framer-motion",
	"three",
	"d3",
	"openai",
	"langchain",
	"anthropic",
]);

/**
 * Allowlist of well-known legitimate npm packages whose short names collide
 * with `POPULAR_PACKAGES` at Levenshtein distance ≤2. These are popular dev
 * tools (TypeScript runners, build wrappers, CLI utilities, etc.) whose
 * names are only 3–4 characters and therefore trip the typosquat heuristic
 * on every `package.json` edit despite being legitimate.
 *
 * Rule of thumb for adding here: must be in wide use (100k+ weekly downloads
 * or part of an established toolchain), published by a known maintainer, and
 * confirmed by the team. This list is additive — it never relaxes typosquat
 * detection for anything outside it.
 *
 * Namespaced orgs (`@types/`, `@typescript-eslint/`, etc.) are handled
 * separately via `isAllowlistedScope()` below.
 */
const KNOWN_LEGITIMATE_PACKAGES = new Set([
	// TypeScript toolchain
	"tsup", // ESM bundler by Anthony Fu (~1M weekly)
	"tsx", // TypeScript execute by egoist (~3M weekly)
	"tsc", // TypeScript compiler binary alias
	"tslib", // Official TypeScript runtime helpers
	"tsd", // TypeScript definition tester
	"tsdown", // Rolldown-based TS bundler
	"tsimp", // Modern ts-node alternative
	"ts-node", // Traditional TS runner
	"ts-jest", // Jest TS transformer
	"ts-morph", // TS compiler API wrapper
	"ts-pattern", // Exhaustive pattern matching
	"ts-toolbelt", // Type-level utilities
	"tsc-alias", // Path alias resolution
	"tsconfig-paths", // Path alias resolution at runtime
	"tsconfck", // tsconfig lookup
	"tsutils", // TS AST utilities
	"type-fest", // Curated type utilities
	// Build + bundling
	"turbo", // Turborepo
	"nx", // Nx monorepo
	"lerna", // Monorepo manager
	"unbuild", // unjs bundler
	"microbundle", // preact-team bundler
	"magic-string", // Source map-aware string editing
	"unplugin", // Framework-agnostic plugin API
	// CLI + process helpers
	"execa", // Better child_process
	"zx", // Google shell scripting
	"shelljs", // Unix shell commands
	"cross-env", // Cross-platform env vars
	"npm-run-all", // Run npm scripts in parallel
	"concurrently", // Same as above
	"rimraf", // Cross-platform rm -rf
	"nodemon", // Dev file watcher
	"husky", // Git hooks
	"lint-staged", // Run linters on staged files
	// Parsing / data
	"yaml", // YAML parser (eemeli)
	"toml", // TOML parser
	"ini", // INI parser (isaacs)
	"semver", // Semantic versioning
	"minimist", // Arg parser
	"mri", // Smaller arg parser (lukeed)
	"cac", // CLI arg framework
	"meow", // CLI helper (sindresorhus)
	"citty", // unjs CLI builder
	// Async + flow control
	"p-limit", // Concurrency limit
	"p-queue", // Promise queue
	"p-map", // Concurrent map
	"p-retry", // Retry a promise
	"p-timeout", // Timeout a promise
	// HTTP (less-popular but legit)
	"undici", // Node.js native HTTP/2 client
	"cross-fetch", // Isomorphic fetch polyfill
	"ofetch", // unjs fetch wrapper
	"h3", // unjs HTTP server
	"hono", // Ultrafast edge web framework
	"koa", // Web framework (distinct from express)
	"fastify", // Fast web framework
	"polka", // Micro web framework
	"itty-router", // Edge router
	// IDs / tiny utils
	"nanoid", // Tiny ID generator
	"ulid", // Lexicographically sortable IDs
	"cuid", // Collision-resistant IDs
	"mime", // MIME type lookup
	"mitt", // Tiny event emitter
	"defu", // Object default merger
	"deepmerge", // Deep object merge
	// Glob + fs
	"fast-glob", // Fast glob
	"micromatch", // Pattern matching
	"picomatch", // Pattern matching (smaller)
	"anymatch", // Glob matcher
	"normalize-path", // Path normalization
	"find-up", // Walk up looking for file
	"pkg-dir", // Find package.json dir
	"env-paths", // OS-standard paths
	// Runtimes / package managers
	"bun", // Runtime (oven-sh)
	"bun-types", // Bun type declarations
	"deno", // Runtime
	"pnpm", // Package manager
	"yarn", // Package manager
	"wrangler", // Cloudflare Workers CLI
	"miniflare", // Workers test runner
	// Terminal + output
	"ora", // Terminal spinner
	"boxen", // Terminal boxes
	"chalk-template", // chalk template literal variant
	"colorette", // Color alternative
	"picocolors", // Smallest color lib
	"kolorist", // Another small color lib
	"ansi-colors", // Color alternative
	"strip-ansi", // Strip ANSI codes
	"supports-color", // Feature detection
	// Git / vcs
	"simple-git", // git wrapper
	"isomorphic-git", // Pure JS git
]);

/**
 * Regex-based allowlist for scoped orgs whose package names are inherently
 * short (and therefore prone to Levenshtein collisions). `@types/foo`,
 * `@typescript-eslint/parser`, `@vitejs/plugin-react`, etc. are legitimate
 * by construction — the scope itself attests to origin.
 */
const ALLOWLISTED_SCOPES = [
	/^@types\//,
	/^@typescript-eslint\//,
	/^@typescript\//,
	/^@vitejs\//,
	/^@vitest\//,
	/^@rollup\//,
	/^@esbuild\//,
	/^@swc\//,
	/^@babel\//,
	/^@eslint\//,
	/^@biomejs\//,
	/^@jest\//,
	/^@playwright\//,
	/^@cypress\//,
	/^@testing-library\//,
	/^@nestjs\//,
	/^@next\//,
	/^@vue\//,
	/^@angular\//,
	/^@nuxt\//,
	/^@remix-run\//,
	/^@sveltejs\//,
	/^@astrojs\//,
	/^@tanstack\//,
	/^@emotion\//,
	/^@mui\//,
	/^@tailwindcss\//,
	/^@prisma\//,
	/^@cloudflare\//,
	/^@aws-sdk\//,
	/^@azure\//,
	/^@google-cloud\//,
	/^@sentry\//,
	/^@datadog\//,
	/^@opentelemetry\//,
	/^@anthropic-ai\//,
	/^@openai\//,
	/^@modelcontextprotocol\//,
	/^@unocss\//,
	/^@unjs\//,
	/^@sindresorhus\//,
	/^@inquirer\//,
	/^@commander-js\//,
	/^@clack\//,
	/^@napi-rs\//,
	/^@rspack\//,
	/^@rsbuild\//,
	/^@parcel\//,
];

/** Returns true if `dep` is known-legitimate by name or scope. */
function isAllowlistedDep(dep: string): boolean {
	if (KNOWN_LEGITIMATE_PACKAGES.has(dep)) return true;
	for (const re of ALLOWLISTED_SCOPES) {
		if (re.test(dep)) return true;
	}
	return false;
}

function levenshtein(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	if (Math.abs(a.length - b.length) > 2) return 3; // fast exit
	const matrix: number[][] = [];
	for (let i = 0; i <= a.length; i++) matrix[i] = [i];
	for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost,
			);
		}
	}
	return matrix[a.length][b.length];
}

export function checkTyposquatDependencies(pkgJsonPath: string): InlineMatch[] {
	if (!existsSync(pkgJsonPath)) return [];
	let content: string;
	let pkg: JsonObject;
	try {
		content = readFileSync(pkgJsonPath, "utf-8");
		pkg = JSON.parse(content);
	} catch {
		return [];
	}

	const allDeps: Record<string, string> = {
		...((pkg.dependencies as Record<string, string>) || {}),
		...((pkg.devDependencies as Record<string, string>) || {}),
	};

	const depNames = Object.keys(allDeps);
	if (depNames.length === 0) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const dep of depNames) {
		if (matches.length >= 5) break;
		// Skip if it IS one of the popular packages (exact match)
		if (POPULAR_PACKAGES.has(dep)) continue;
		// Skip if it's in the well-known-legitimate allowlist — these are
		// confirmed-safe dev tools whose short names trip the heuristic
		// (e.g. tsup vs yup, tsx vs ws). The allowlist is additive and never
		// relaxes detection for anything outside it.
		if (isAllowlistedDep(dep)) continue;

		// Check Levenshtein distance to each popular package
		for (const popular of POPULAR_PACKAGES) {
			if (dep === popular) break;
			const dist = levenshtein(dep.toLowerCase(), popular.toLowerCase());
			if (dist > 0 && dist <= 2 && dep.length >= 3) {
				const lineIdx = lines.findIndex((l) => l.includes(`"${dep}"`));
				matches.push({
					line: lineIdx >= 0 ? lineIdx + 1 : 1,
					text: `Possible typosquat: "${dep}" is ${dist} character${dist > 1 ? "s" : ""} away from popular package "${popular}". Verify this is the intended package.`,
				});
				break;
			}
		}
	}
	return matches;
}

// NOTE: Future improvement — "didn't change dependencies" short-circuit.
// Detecting that a package.json edit only bumped the `version` field (or any
// non-deps field) would avoid re-running typosquat scoring entirely. That
// requires threading pre-edit content into this check the way
// `checkPackageJsonPublishInvariants` does (reads from disk at PreToolUse
// time when it still holds old content). At PostToolUse the on-disk copy is
// the new one, so the check would need either an extra `preContent` parameter
// or to receive the Edit tool's `old_string`/`new_string`. Deferred for now:
// the allowlist already kills the observed false positives, and a separate
// re-architecture would touch evaluator/post-tool.ts + the check-registry
// signature. Track as a harness-level deps-diff short-circuit.

/**
 * Detect infinite retry loops without backoff or exit condition.
 * Agents frequently write: while(true) { try { await fetch() } catch { continue } }
 */
export function checkInfiniteRetryLoop(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 5) break;
		const line = lines[i].trim();

		// Pattern: while(true) { try { ...fetch/request... } catch { continue } }
		if (/while\s*\(\s*(true|1)\s*\)/.test(line)) {
			// Look ahead for catch+continue without delay/backoff/break/return
			const block = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
			if (
				/catch\s*\([^)]*\)\s*\{/.test(block) &&
				/\bcontinue\b/.test(block) &&
				!/\b(setTimeout|delay|sleep|backoff|break|return|throw)\b/.test(block) &&
				!/\bretries?\b/i.test(block)
			) {
				matches.push({
					line: i + 1,
					text: lines[i].trim().slice(0, 150),
				});
			}
		}
	}
	return matches;
}

/**
 * Detect hardcoded localhost URLs in production source (not test/config files).
 * Agents leave debug URLs like http://localhost:8787 in production code.
 */
export function checkHardcodedLocalhost(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (/\.(config|fixture|mock|stub)\.\w+$/.test(filePath)) return [];
	if (filePath.includes("__tests__") || filePath.includes("__mocks__")) return [];
	// Allow CLI and config entry points that legitimately reference localhost
	if (isCliFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 5) break;
		const line = lines[i];
		// Skip comments
		if (/^\s*(\/\/|\/?\*|\*)/.test(line)) continue;
		// Match hardcoded localhost URLs with ports (not just localhost in a comment)
		if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(line)) {
			// Don't flag if it's inside a condition or default/fallback pattern
			if (/\?\?|process\.env|fallback|default|development|DEV/i.test(line)) continue;
			matches.push({
				line: i + 1,
				text: lines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect process.exit() in library/module code (not CLI entry points).
 * process.exit() in a library kills the entire process, preventing callers
 * from handling errors. Only appropriate in CLI entry points.
 */
export function checkProcessExitInLibrary(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (isCliFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 3) break;
		const line = lines[i];
		if (/^\s*(\/\/|\/?\*|\*)/.test(line)) continue;
		if (/\bprocess\.exit\s*\(/.test(line)) {
			matches.push({
				line: i + 1,
				text: lines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect imports from dist/ or build/ directories — fragile, breaks on rebuild.
 */
export function checkImportFromDist(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 5) break;
		const line = lines[i].trim();
		// Match: import/require from paths containing dist/ or build/ in relative path
		if (/(?:from\s+|require\s*\(\s*)['"]\.\.?\/[^'"]*?(dist|build)\//.test(line)) {
			matches.push({
				line: i + 1,
				text: lines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect placeholder/dummy values left in config or env files.
 * e.g., YOUR_API_KEY_HERE, TODO_REPLACE, changeme, xxx
 */
export function checkPlaceholderValues(content: string, filePath: string): InlineMatch[] {
	// Only check config-like files
	const name = basename(filePath);
	const isEnvFile =
		name === ".env" ||
		(name.startsWith(".env") &&
			!name.includes("example") &&
			!name.includes("sample") &&
			!name.includes("template"));
	if (!isEnvFile && !/\.(ya?ml|json|toml|ini|cfg|conf)$/.test(name) && !name.includes("config")) {
		return [];
	}
	// Skip example/sample/template files
	if (/\.(example|sample|template)\b/.test(name)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 5) break;
		const line = lines[i];
		if (
			/\b(YOUR_\w*_HERE|REPLACE_?ME|TODO_?REPLACE|CHANGEME|INSERT_?\w*_?HERE|XXX_|PLACEHOLDER|PUT_?YOUR)\b/i.test(
				line,
			)
		) {
			matches.push({
				line: i + 1,
				text: lines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}

/**
 * Detect error messages that leak implementation details to clients.
 * e.g., catch(e) { res.json({ error: e.message }) } — exposes stack traces
 */
export function checkErrorMessageLeakage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 5) break;
		const line = lines[i];
		if (/^\s*(\/\/|\/?\*|\*)/.test(line)) continue;
		// Pattern: res.json/res.send/Response with raw error
		if (
			/\bres\.(json|send|status)\b.*\b(err?|error|exception|e)\.(message|stack|toString)\b/.test(
				line,
			) ||
			/\bnew\s+Response\b.*\b(err?|error|exception|e)\.(message|stack|toString)\b/.test(line)
		) {
			matches.push({
				line: i + 1,
				text: lines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}
