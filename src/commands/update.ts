// ===========================================
// Update Command — Update guidance for the Interlinked CLI
// ===========================================
// Resolves the CLI's install location. npm-installed copies update through
// npm; source checkouts can still pull/build in place for local development.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { c } from "../lib/formatter.js";

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

export async function updateCommand(opts: { json?: boolean; force?: boolean }): Promise<void> {
	const cliRoot = resolveCliRoot();

	if (!cliRoot) {
		if (opts.json) {
			console.log(
				JSON.stringify({ success: false, error: "Cannot resolve CLI install location" }),
			);
		} else {
			console.error(`${c.red("Error:")} Cannot resolve CLI install location.`);
			console.error(
				"Install Interlinked CLI with npm, or run this command from a source checkout.",
			);
		}
		process.exit(1);
	}

	const repoRoot = resolveSourceRepoRoot(cliRoot);
	if (!repoRoot) {
		const command = "npm install -g interlinked-cli@latest";
		if (opts.json) {
			console.log(
				JSON.stringify({
					success: true,
					managed_by: "npm",
					command,
				}),
			);
		} else {
			console.log("This Interlinked CLI install is managed by npm.");
			console.log(`Run: ${command}`);
		}
		return;
	}

	if (opts.json) {
		console.log(JSON.stringify({ cli_root: cliRoot, repo_root: repoRoot, updating: true }));
	} else {
		console.log(`${c.bold("Interlinked CLI — Self-Update")}`);
		console.log(c.dim("────────────────────────────────────────"));
		console.log(`${c.dim("CLI root:")}  ${cliRoot}`);
		console.log(`${c.dim("Repo root:")} ${repoRoot}`);
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
			run("npm install --no-audit --no-fund", cliRoot);
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

	// Step 4: Regenerate hook script in current directory (if .interlinked/ exists)
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

	// Step 5: Show new version
	const newVersion = getInstalledVersion(cliRoot);
	if (opts.json) {
		console.log(JSON.stringify({ success: true, version: newVersion, pulled }));
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

function resolveSourceRepoRoot(cliRoot: string): string | null {
	const candidates = [cliRoot, dirname(cliRoot)];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, ".git")) && existsSync(join(cliRoot, "src", "index.ts"))) {
			return candidate;
		}
	}
	return null;
}
