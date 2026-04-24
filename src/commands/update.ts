// ===========================================
// Update Command — Self-update the Interlinked CLI
// ===========================================
// Source checkouts pull/build in place. If the running binary is not already
// tied to a source checkout, bootstrap a managed GitHub checkout and link it.

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { c } from "../lib/formatter.js";

export const INTERLINKED_CLI_REPO_URL = "https://github.com/QuentinCody/interlinked-cli.git";

export function getManagedSourceRoot(home = homedir()): string {
	return join(home, ".interlinked", "interlinked-cli");
}

/** Resolve the monorepo root from the running binary's symlink */
function resolveCliRoot(): string | null {
	try {
		// The binary is at cli/dist/index.js — resolve symlinks to find the real path
		const binPath = realpathSync(process.argv[1]);
		// Walk up from dist/index.js to cli/
		let dir = dirname(binPath);
		for (let i = 0; i < 5; i++) {
			if (existsSync(join(dir, "package.json"))) {
				const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
				if (pkg.name === "interlinked-cli") return dir;
			}
			dir = dirname(dir);
		}
	} catch (_) {
		/* intentional: best-effort scan for package root, null means not found */
	}
	return null;
}

function run(cmd: string, cwd: string): string {
	return execSync(cmd, { cwd, encoding: "utf-8", timeout: 60_000 }).trim();
}

function runFile(file: string, args: string[], cwd: string, timeout = 120_000): string {
	return execFileSync(file, args, { cwd, encoding: "utf-8", timeout }).trim();
}

function fail(opts: { json?: boolean }, message: string): never {
	if (opts.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(`${c.red("Error:")} ${message}`);
	}
	process.exit(1);
}

export async function updateCommand(opts: { json?: boolean; force?: boolean }): Promise<void> {
	let cliRoot = resolveCliRoot();

	let repoRoot = cliRoot ? resolveSourceRepoRoot(cliRoot) : null;
	let managedCheckout = false;
	if (!repoRoot) {
		repoRoot = ensureManagedSourceCheckout(opts);
		cliRoot = repoRoot;
		managedCheckout = true;
	}

	if (!cliRoot) {
		fail(opts, "Cannot resolve CLI install location");
	}

	if (opts.json) {
		console.log(
			JSON.stringify({
				cli_root: cliRoot,
				repo_root: repoRoot,
				repo_url: INTERLINKED_CLI_REPO_URL,
				managed_checkout: managedCheckout,
				updating: true,
			}),
		);
	} else {
		console.log(`${c.bold("Interlinked CLI — Self-Update")}`);
		console.log(c.dim("────────────────────────────────────────"));
		console.log(`${c.dim("CLI root:")}  ${cliRoot}`);
		console.log(`${c.dim("Repo root:")} ${repoRoot}`);
		if (managedCheckout) console.log(`${c.dim("Repo URL:")}  ${INTERLINKED_CLI_REPO_URL}`);
		console.log();
	}

	// Step 1: Check for git changes
	const isGitRepo = existsSync(join(repoRoot, ".git"));
	let pulled = false;

	if (isGitRepo) {
		try {
			const status = run("git status --porcelain", repoRoot);
			const branch = run("git rev-parse --abbrev-ref HEAD", repoRoot);
			const beforeSha = run("git rev-parse --short HEAD", repoRoot);

			if (!opts.json) {
				console.log(`${c.dim("Branch:")} ${branch} (${beforeSha})`);
			}

			if (status && !opts.force) {
				if (!opts.json) {
					console.log(`${c.yellow("Warning:")} Working tree has uncommitted changes.`);
					console.log(c.dim("Use --force to pull anyway, or commit/stash first."));
					console.log();
					console.log(c.dim("Skipping git pull — rebuilding from current source."));
				}
			} else {
				if (!opts.json) process.stdout.write("Pulling latest... ");
				try {
					run("git pull --ff-only", repoRoot);
					const afterSha = run("git rev-parse --short HEAD", repoRoot);
					pulled = beforeSha !== afterSha;
					if (!opts.json) {
						if (pulled) {
							console.log(`${c.green("updated")} ${beforeSha} → ${afterSha}`);
						} else {
							console.log(c.green("already up to date"));
						}
					}
				} catch {
					if (!opts.json) {
						console.log(
							c.yellow("skipped (pull failed — rebuilding from current source)"),
						);
					}
				}
			}
		} catch {
			if (!opts.json)
				console.log(c.dim("Git not available — rebuilding from current source."));
		}
	}

	// Step 2: Install dependencies if needed
	const nodeModules = join(cliRoot, "node_modules");
	if (pulled || !existsSync(nodeModules)) {
		if (!opts.json) process.stdout.write("Installing dependencies... ");
		try {
			const installCmd = existsSync(join(cliRoot, "package-lock.json"))
				? "npm ci --no-audit --no-fund"
				: "npm install --no-audit --no-fund";
			run(installCmd, cliRoot);
			if (!opts.json) console.log(c.green("done"));
		} catch {
			if (!opts.json) console.log(c.yellow("skipped (install failed)"));
		}
	}

	// Step 3: Build
	if (!opts.json) process.stdout.write("Building... ");
	try {
		run("npm run build", cliRoot);
		if (!opts.json) console.log(c.green("done"));
	} catch (err) {
		if (opts.json) {
			console.log(JSON.stringify({ success: false, error: "Build failed" }));
		} else {
			console.error(`${c.red("Build failed:")}`);
			console.error(String(err));
		}
		process.exit(1);
	}

	// Step 4: Link managed source checkouts so future `interlinked` invocations
	// use the freshly-built GitHub checkout.
	let linked = false;
	if (managedCheckout) {
		if (!opts.json) process.stdout.write("Linking CLI binaries... ");
		try {
			run("npm link", cliRoot);
			linked = true;
			if (!opts.json) console.log(c.green("done"));
		} catch (err) {
			if (opts.json) {
				console.log(JSON.stringify({ success: false, error: "npm link failed" }));
			} else {
				console.log(c.red("failed"));
				console.error(String(err));
			}
			process.exit(1);
		}
	}

	// Step 5: Regenerate hook script in current directory (if .interlinked/ exists)
	const cwd = process.cwd();
	const interlinkedDir = join(cwd, ".interlinked");
	if (existsSync(interlinkedDir)) {
		if (!opts.json) process.stdout.write("Regenerating hook script... ");
		try {
			const { writeHookScript } = await import("../lib/hooks.js");
			writeHookScript(cwd);
			if (!opts.json) console.log(c.green("done"));
		} catch {
			if (!opts.json) console.log(c.yellow("skipped (hook regeneration failed)"));
		}
	}

	// Step 6: Show new version
	const newVersion = getInstalledVersion(cliRoot);
	if (opts.json) {
		console.log(
			JSON.stringify({
				success: true,
				version: newVersion,
				pulled,
				linked,
				managed_checkout: managedCheckout,
				repo_root: repoRoot,
			}),
		);
	} else {
		console.log();
		console.log(`${c.green("Updated")} to Interlinked CLI v${newVersion}`);
	}
}

function getInstalledVersion(cliRoot: string): string {
	try {
		const pkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf-8"));
		return pkg.version || "unknown";
	} catch {
		return "unknown";
	}
}

function ensureManagedSourceCheckout(opts: { json?: boolean; force?: boolean }): string {
	const repoRoot = getManagedSourceRoot();
	const parent = dirname(repoRoot);
	mkdirSync(parent, { recursive: true });

	if (!existsSync(repoRoot)) {
		if (!opts.json) {
			console.log(`${c.bold("Interlinked CLI — GitHub Checkout")}`);
			console.log(c.dim("────────────────────────────────────────"));
			console.log(`${c.dim("Repo URL:")}  ${INTERLINKED_CLI_REPO_URL}`);
			console.log(`${c.dim("Target:")}    ${repoRoot}`);
			process.stdout.write("Cloning source... ");
		}
		try {
			runFile("git", ["clone", INTERLINKED_CLI_REPO_URL, repoRoot], parent);
			if (!opts.json) console.log(c.green("done"));
		} catch (err) {
			if (!opts.json) console.log(c.red("failed"));
			fail(opts, `Failed to clone ${INTERLINKED_CLI_REPO_URL}: ${String(err)}`);
		}
		return repoRoot;
	}

	if (!resolveSourceRepoRoot(repoRoot)) {
		fail(
			opts,
			`Managed checkout path exists but is not an interlinked-cli source checkout: ${repoRoot}`,
		);
	}

	try {
		runFile("git", ["remote", "set-url", "origin", INTERLINKED_CLI_REPO_URL], repoRoot);
	} catch {
		/* non-fatal: pull below will surface any real git problem */
	}

	return repoRoot;
}

export function resolveSourceRepoRoot(cliRoot: string): string | null {
	const candidates = [cliRoot, dirname(cliRoot)];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, ".git")) && existsSync(join(cliRoot, "src", "index.ts"))) {
			return candidate;
		}
	}
	return null;
}
