// Daemon-side supply-chain guard for package-install shell commands.
//
// Takes the parsed install commands + the project's allowlist + cwd, and
// returns a HarnessDecision (or null when there's nothing to evaluate).
//
// Block triggers (fail-closed):
//   1. Custom --registry / --index-url / --source — bypasses signing.
//   2. git/tarball/file URL specs — bypass registry audit.
//   3. Registry packages not on the per-ecosystem allowlist.
//   4. Lockfile-locked installs where the lockfile hash doesn't match a
//      stored snapshot.
//   5. Manifest-only syncs (no positional args) where neither the
//      manifest nor any colocated lockfile matches a stored snapshot.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type Allowlist,
	hashLockfile,
	isPackageAllowed,
	matchSnapshot,
} from "../package-allowlist.js";
import type { Ecosystem, InstallCommand } from "../package-install-parser.js";
import type { HarnessDecision } from "../types.js";

interface ManifestSearchEntry {
	manifest: string;
	lockfiles: string[];
}

const MANIFEST_BY_ECOSYSTEM: Record<Ecosystem, ManifestSearchEntry[]> = {
	npm: [
		{
			manifest: "package.json",
			lockfiles: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"],
		},
	],
	pypi: [
		{ manifest: "pyproject.toml", lockfiles: ["poetry.lock", "uv.lock", "pdm.lock"] },
		{ manifest: "requirements.txt", lockfiles: ["requirements.lock"] },
		{ manifest: "Pipfile", lockfiles: ["Pipfile.lock"] },
	],
	cargo: [{ manifest: "Cargo.toml", lockfiles: ["Cargo.lock"] }],
	rubygems: [{ manifest: "Gemfile", lockfiles: ["Gemfile.lock"] }],
	go: [{ manifest: "go.mod", lockfiles: ["go.sum"] }],
};

export function evaluatePackageInstall(
	commands: InstallCommand[],
	cwd: string,
	allowlist: Allowlist,
): HarnessDecision | null {
	if (commands.length === 0) return null;

	for (const cmd of commands) {
		const verdict = evaluateOne(cmd, cwd, allowlist);
		if (verdict) return verdict;
	}
	return { decision: "allow" };
}

function evaluateOne(
	cmd: InstallCommand,
	cwd: string,
	allowlist: Allowlist,
): HarnessDecision | null {
	// Uninstall / no-op: nothing new can enter the supply chain, allow.
	if (cmd.action === "remove" || cmd.action === "noop") return null;
	// Resolve the cwd to use for manifest/lockfile lookups. A preceding
	// `cd <path>` in the same compound shell line shifts this away from
	// the event's cwd — without honoring it, a root-package snapshot can
	// allow an unsnapshotted subpackage install (and vice-versa).
	const effectiveCwd = cmd.effectiveCwd
		? isAbsolute(cmd.effectiveCwd)
			? cmd.effectiveCwd
			: resolve(cwd, cmd.effectiveCwd)
		: cwd;

	// Custom registry — always suspect. An attacker who can flip --registry
	// can serve any package payload, bypassing the upstream signing model.
	if (cmd.customRegistry) {
		return block(
			`Custom registry "${cmd.customRegistry}" on ${cmd.manager} install is never auto-allowed. Use the default ecosystem registry, or remove the override.`,
			"supply-chain-custom-registry",
		);
	}

	// Positional packages — check each against the per-ecosystem allowlist.
	if (cmd.packages.length > 0) {
		for (const spec of cmd.packages) {
			const dec = isPackageAllowed(allowlist, cmd.ecosystem, spec);
			if (!dec.allowed) {
				return block(
					`${cmd.manager} ${cmd.action}: ${dec.reason ?? "unapproved package"}`,
					"supply-chain-unapproved-package",
				);
			}
		}
		return null; // every package OK, fall through to next command
	}

	// Sync from manifest/lockfile without positional args. Require a stored
	// snapshot match — either the manifest or any of its colocated lockfiles.
	// All path resolutions use effectiveCwd so a `cd subdir && npm ci` checks
	// the subdirectory's lockfile, not the root's.
	if (cmd.fromLockfile || cmd.fromManifest) {
		const entries = MANIFEST_BY_ECOSYSTEM[cmd.ecosystem] ?? [];
		// 1. Prefer lockfiles when one exists (stronger guarantee than manifest).
		for (const entry of entries) {
			for (const lf of entry.lockfiles) {
				const p = join(effectiveCwd, lf);
				if (!isExistingFile(p)) continue;
				if (matchSnapshot(allowlist, lf, p)) return null;
			}
		}
		// 2. Fall back to manifest snapshot when no lockfile snapshot matched.
		for (const entry of entries) {
			const p = join(effectiveCwd, entry.manifest);
			if (!isExistingFile(p)) continue;
			if (matchSnapshot(allowlist, entry.manifest, p)) return null;
		}
		// Nothing matched.
		const presentFiles = entries
			.flatMap((e) => [e.manifest, ...e.lockfiles])
			.filter((f) => isExistingFile(join(effectiveCwd, f)));
		const hint = presentFiles.length
			? ` Run \`interlinked allowlist snapshot\` to approve the current state of: ${presentFiles.join(", ")}.`
			: ` Initial bootstrap: \`interlinked allowlist add ${cmd.ecosystem} <package>\` per package, or \`interlinked allowlist snapshot\` once the manifest is in place.`;
		const presentHashes = presentFiles
			.map((f) => `${f}=${(hashLockfile(join(effectiveCwd, f)) ?? "?").slice(0, 12)}`)
			.join(" ");
		const cwdNote = cmd.effectiveCwd ? ` [in ${cmd.effectiveCwd}]` : "";
		return block(
			`${cmd.manager} ${cmd.action}${cwdNote}: no allowlist snapshot matches the current ${cmd.ecosystem} manifest/lockfile state.${hint}${presentHashes ? ` (current hashes: ${presentHashes})` : ""}`,
			"supply-chain-snapshot-mismatch",
		);
	}

	// Catch-all: install_global with no positional packages (e.g. malformed
	// `cargo install` with no crate name) — fail closed.
	if (cmd.action === "install_global") {
		return block(
			`${cmd.manager} ${cmd.action} requires explicit package arg; refusing implicit install.`,
			"supply-chain-bare-install-global",
		);
	}

	return null;
}

function block(reason: string, ruleId: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:supply-chain] ${reason}`,
		rule_id: ruleId,
		severity: "high",
		category: "supply-chain",
	};
}

function isExistingFile(path: string): boolean {
	if (!existsSync(path)) return false;
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
