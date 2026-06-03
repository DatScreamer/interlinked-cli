#!/usr/bin/env node
// =====================================================================
// Doc-fact extractor
// =====================================================================
//
// Source-of-truth for every dynamic value referenced in
// landing/public/index.html, README.md, and CLAUDE.md. Reads the
// codebase, returns canonical values as JSON on stdout.
//
// Used by:
//   - scripts/check-docs.mjs         (build/check the marker-substituted docs)
//   - .github/workflows/ci.yml       (fail CI on drift)
//
// Add a new fact:
//   1. Implement an `extract*()` function below.
//   2. Add it to the `facts` object at the bottom.
//   3. In landing/README, wrap the value in `<!-- gen:foo -->VALUE<!-- /gen:foo -->`
//      (HTML) or `<!-- gen:foo -->VALUE<!-- /gen:foo -->` (Markdown — same syntax).
//   4. Add a `MARKERS["foo"] = "facts.foo"` mapping in scripts/check-docs.mjs.
//
// No runtime dependencies — runs on Node 18+.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------
// Built-in guard rules — count + reason map
// ---------------------------------------------------------------------
// All rules with `id: "..."` across src/harness/rules/builtin-rules-*.ts.
// We also capture each rule's `reason: "..."` so that landing-page
// terminal mockups quoting a rule's reason can be verified verbatim.
function extractBuiltinRules() {
	const dir = join(ROOT, "src/harness/rules");
	const files = readdirSync(dir)
		.filter((f) => f.startsWith("builtin-rules-") && f.endsWith(".ts"))
		.sort();
	const reasons = {};
	const ids = [];
	for (const file of files) {
		const text = readFileSync(join(dir, file), "utf8");
		// Walk every `{` block, looking for { id: "...", ..., reason: "...", ... }.
		// Regex-only — no AST — but the codebase formatting is consistent.
		const blockRe = /\{[\s\S]*?\bid:\s*["']([^"']+)["'][\s\S]*?(?=\n\t\}|\n  \},|\n\},)/g;
		for (const m of text.matchAll(blockRe)) {
			const block = m[0];
			const id = m[1];
			ids.push(id);
			const reasonMatch = block.match(/\breason:\s*["']([^"']+)["']/);
			if (reasonMatch) reasons[id] = reasonMatch[1];
		}
	}
	return { count: ids.length, ids, reasons };
}

// ---------------------------------------------------------------------
// Agent runners — keys of CLIENT_INSTALL_REGISTRY
// ---------------------------------------------------------------------
// The registry's keys are the canonical short names; the landing page
// sometimes uses display names (e.g. "Claude Code" instead of "claude").
// We expose both shapes.
function extractRunners() {
	const text = read("src/lib/hooks.ts");
	const m = text.match(/CLIENT_INSTALL_REGISTRY[^=]*=\s*\{([\s\S]*?)\n\};/);
	if (!m) throw new Error("CLIENT_INSTALL_REGISTRY not found in src/lib/hooks.ts");
	const keys = [...m[1].matchAll(/^\s*(\w+):\s*\{/gm)].map((x) => x[1]);
	const DISPLAY = {
		claude: "Claude Code",
		copilot: "Copilot CLI",
		gemini: "Gemini CLI",
		codex: "Codex",
		cursor: "Cursor",
	};
	return {
		count: keys.length,
		keys,
		display: keys.map((k) => DISPLAY[k] || k),
	};
}

// ---------------------------------------------------------------------
// Enforcement modes — values of `ModeName` type in modes.ts
// ---------------------------------------------------------------------
// "custom" is internal and not user-facing; the landing page lists the
// three user-selectable modes. We expose both lists so docs can choose.
function extractModes() {
	const text = read("src/harness/modes.ts");
	const m = text.match(/export type ModeName\s*=\s*([^;]+);/);
	if (!m) throw new Error("ModeName type not found in src/harness/modes.ts");
	const all = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
	const userFacing = all.filter((n) => n !== "custom");
	return { all, user_facing: userFacing };
}

// ---------------------------------------------------------------------
// Node minimum version — package.json#engines.node
// ---------------------------------------------------------------------
function extractNodeMin() {
	let pkg;
	try {
		pkg = JSON.parse(read("package.json"));
	} catch (err) {
		throw new Error(`package.json is not valid JSON: ${err.message}`, { cause: err });
	}
	const raw = pkg.engines?.node;
	if (!raw) return null;
	const m = raw.match(/(\d+)/);
	return m ? Number.parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------
// Update-check feature — present iff source defines REGISTRY_URL +
// honors INTERLINKED_NO_UPDATE_CHECK in src/.
// ---------------------------------------------------------------------
// FAQ on the landing page describes this; the FAQ is only valid if the
// feature actually ships from current src/. Stale dist/ doesn't count.
function extractUpdateCheckPresent() {
	const sourceFiles = walkTs(join(ROOT, "src")).filter((p) => !p.includes("__tests__"));
	let hasRegistryUrl = false;
	let honorsOptOut = false;
	for (const file of sourceFiles) {
		const t = readFileSync(file, "utf8");
		if (t.includes("registry.npmjs.org/interlinked-cli")) hasRegistryUrl = true;
		if (t.includes("INTERLINKED_NO_UPDATE_CHECK")) honorsOptOut = true;
	}
	return { has_registry_url: hasRegistryUrl, honors_opt_out: honorsOptOut };
}

function walkTs(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walkTs(full, acc);
		else if (entry.isFile() && full.endsWith(".ts")) acc.push(full);
	}
	return acc;
}

// ---------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------
const builtin = extractBuiltinRules();
const runners = extractRunners();
const modes = extractModes();
const updateCheck = extractUpdateCheckPresent();

const facts = {
	builtin_rule_count: builtin.count,
	builtin_rule_ids: builtin.ids,
	builtin_rule_reasons: builtin.reasons,
	runner_count: runners.count,
	runner_keys: runners.keys,
	runner_display: runners.display,
	runners_inline: runners.display.join(", "),
	mode_names_user_facing: modes.user_facing,
	mode_names_inline: modes.user_facing.join(" / "),
	node_min_version: extractNodeMin(),
	update_check_in_source: updateCheck.has_registry_url && updateCheck.honors_opt_out,
};

process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
