// ===========================================
// interlinked install-hooks — multi-runner installer (Phase D)
// ===========================================
// Adapter-multiplexing installer. Distinct from `interlinked enable` — that
// command handles the legacy 2-runner Claude+Copilot pipeline and the
// .interlinked/ config scaffold. `install-hooks` targets the adapter-based
// runtime introduced in Phase A–C and uses the installer-manifest.json for
// precise uninstall.

import { existsSync, mkdirSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installHooks, manifestPath } from "../harness/installer.js";
import { ALL_PRESETS, isKnownMode, type ModeName } from "../harness/modes.js";
import type { RunnerId } from "../harness/unified-event.js";
import { writeHookScript } from "../lib/hooks.js";
import { writeMode } from "./mode.js";

export interface InstallHooksOptions {
	runner?: string;
	scope?: string;
	cloud?: string;
	tokenEnv?: string;
	binary?: string;
	dryRun?: boolean;
	json?: boolean;
	/** balanced | strict | lenient — skips the interactive prompt when set. */
	mode?: string;
}

const VALID_RUNNERS = new Set<RunnerId>([
	"claude-code",
	"copilot-cli",
	"cursor",
	"gemini-cli",
	"codex",
]);
const VALID_SCOPES = new Set(["user", "project", "local"]);
const VALID_CLOUD_PRODUCTS = new Set(["guardrails", "agent-ci"]);

export async function installHooksCommand(options: InstallHooksOptions): Promise<void> {
	const cwd = process.cwd();
	const runners = parseRunners(options.runner);
	const scope = parseScope(options.scope);
	const dryRun = options.dryRun === true;
	const binaryPath = resolve(options.binary ?? defaultBinaryPath(cwd, { writeFallback: !dryRun }));

	// Resolve enforcement mode: explicit flag > interactive prompt > balanced.
	const resolvedMode = resolveMode(options);

	const result = installHooks({ cwd, binaryPath, runners, scope, dryRun });

	if (!dryRun) {
		writeMode(cwd, resolvedMode, false);
	}

	if (options.cloud && !dryRun) {
		writeCloudConfig(cwd, options.cloud, options.tokenEnv);
	}

	if (options.json) {
		const payload = {
			ok: true,
			dry_run: dryRun,
			entries: result.entries,
			skipped: result.skipped,
			manifest_path: result.manifest_path,
			mode: resolvedMode,
			cloud: options.cloud ?? null,
		};
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		return;
	}

	printHuman(result, dryRun, resolvedMode);
}

/** Explicit --mode wins. In a TTY with no flag, prompt. Otherwise default
 *  to balanced. Unknown values fall back to balanced with a stderr warning. */
function resolveMode(options: InstallHooksOptions): ModeName {
	if (options.mode) {
		if (isKnownMode(options.mode)) return options.mode;
		process.stderr.write(
			`[interlinked] unknown mode '${options.mode}'; falling back to balanced\n`,
		);
		return "balanced";
	}
	if (options.json || !process.stdin.isTTY) return "balanced";
	return promptForMode();
}

function promptForMode(): ModeName {
	process.stdout.write("\nPick an enforcement mode:\n");
	for (let i = 0; i < ALL_PRESETS.length; i++) {
		const p = ALL_PRESETS[i];
		const label = p.name === "balanced" ? `${p.name} (default)` : p.name;
		process.stdout.write(`  ${i + 1}. ${label.padEnd(18)} ${p.description}\n`);
	}
	process.stdout.write("\nEnter a number, a name, or press Enter for the default.\n> ");
	const raw = readStdinLine();
	return parseModeChoice(raw);
}

export function parseModeChoice(raw: string): ModeName {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed.length === 0) return "balanced";
	const n = Number.parseInt(trimmed, 10);
	if (Number.isFinite(n) && n >= 1 && n <= ALL_PRESETS.length) {
		return ALL_PRESETS[n - 1].name;
	}
	if (isKnownMode(trimmed)) return trimmed;
	return "balanced";
}

function readStdinLine(): string {
	const buf = Buffer.alloc(4096);
	let read = 0;
	try {
		read = readSync(0, buf, 0, 4096, null);
	} catch {
		return "";
	}
	return buf.toString("utf-8", 0, read);
}

function parseRunners(raw: string | undefined): RunnerId[] {
	if (!raw || raw === "all") return [];
	const parts = raw.split(",").map((s) => s.trim());
	const out: RunnerId[] = [];
	for (const part of parts) {
		if (VALID_RUNNERS.has(part as RunnerId)) {
			out.push(part as RunnerId);
		} else {
			process.stderr.write(`[interlinked] warning: unknown runner ${part}; skipping\n`);
		}
	}
	return out;
}

function parseScope(raw: string | undefined): "user" | "project" | "local" {
	if (!raw) return "project";
	if (!VALID_SCOPES.has(raw)) {
		process.stderr.write(`[interlinked] warning: unknown scope ${raw}; using "project"\n`);
		return "project";
	}
	return raw as "user" | "project" | "local";
}

function defaultBinaryPath(cwd: string, opts: { writeFallback: boolean }): string {
	// Prefer an existing project-local hook override, then the packaged
	// hook-entry bundled beside dist/index.js. Source checkouts without a
	// build still get the legacy self-contained hook script as a fallback.
	const compiled = join(cwd, ".interlinked", "hooks", "interlinked-hook");
	if (existsSync(compiled)) return compiled;

	const packaged = packagedHookEntryPath();
	if (packaged && existsSync(packaged)) return packaged;

	const legacy = join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
	if (existsSync(legacy)) return legacy;
	if (opts.writeFallback) return writeHookScript(cwd);
	return legacy;
}

function packagedHookEntryPath(): string | null {
	const invoked = process.argv[1];
	if (!invoked) return null;
	try {
		const real = realpathSync(invoked);
		const candidate = join(dirname(real), "hook-entry.js");
		if (existsSync(candidate)) return candidate;
	} catch {
		return null;
	}
	return null;
}

function writeCloudConfig(cwd: string, product: string, tokenEnv: string | undefined): void {
	if (!VALID_CLOUD_PRODUCTS.has(product)) {
		process.stderr.write(
			`[interlinked] warning: unknown cloud product ${product}; skipping cloud opt-in\n`,
		);
		return;
	}
	const cfgDir = join(cwd, ".interlinked");
	if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
	const payload = {
		enabled: true,
		product,
		portal_url:
			product === "guardrails"
				? "https://portal.interlinked.dev/mcp"
				: "https://portal.interlinked.dev/agent-ci",
		token_source: tokenEnv ? { env: tokenEnv } : null,
		zdr: false,
		redactors_before_send: ["secrets", "paths"],
	};
	writeFileSync(join(cfgDir, "cloud.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

function printHuman(
	result: {
		entries: Array<{ runner: string; settings_path: string; added_paths: string[] }>;
		skipped: Array<{ runner: string; reason: string }>;
		manifest_path: string;
	},
	dryRun: boolean,
	mode: ModeName,
): void {
	const verb = dryRun ? "would install" : "installed";
	process.stdout.write(`[interlinked] ${verb} hooks for ${result.entries.length} runner(s)\n`);
	for (const e of result.entries) {
		process.stdout.write(
			`  ${e.runner.padEnd(14)} → ${e.settings_path} (${e.added_paths.length} path(s))\n`,
		);
	}
	for (const s of result.skipped) {
		process.stdout.write(`  ${s.runner.padEnd(14)} skipped: ${s.reason}\n`);
	}
	process.stdout.write(`manifest: ${manifestPath(process.cwd())}\n`);
	if (!dryRun) {
		process.stdout.write(`mode: ${mode}  (change anytime: interlinked mode <name>)\n`);
	}
}
