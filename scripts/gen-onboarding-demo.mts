// interlinked-tdd: exempt — this generator's test is the freshness pin in
// src/commands/onboarding-demo-freshness.test.ts, which executes it in --check
// mode and fails when the committed demo drifts from the wizard module.
// ===========================================
// Onboarding-demo generator — the zero-drift contract, made executable
// ===========================================
// Bundles the REAL src/commands/setup-wizard.ts (plus the preset and cap
// registries the wizard renders from) into docs/demo/onboarding-demo.html.
// The browser demo therefore EXECUTES the shipped copy, defaults, parsers,
// and plan renderer — it cannot say something the terminal would not.
//
//   node --experimental-strip-types scripts/gen-onboarding-demo.mts           # regenerate
//   node --experimental-strip-types scripts/gen-onboarding-demo.mts --check   # exit 1 on drift
//
// (Run via `npx tsx` in practice; the pin test does.)
//
// node:fs / node:path are stubbed at bundle time: the only consumer inside
// the bundled graph is writeScopeConfig + registry file readers, none of
// which the demo calls — the stubs make that an explicit, loud contract
// (throwing on use) instead of a silent browser crash.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "scripts", "onboarding-demo-template.html");
const OUT = join(ROOT, "docs", "demo", "onboarding-demo.html");
const PLACEHOLDER = "<!--WIZARD_BUNDLE-->";

const ENTRY = `
export {
  WIZARD_COPY,
  DEFAULT_WIZARD_CHOICES,
  describeWizardPlan,
  moveSelection,
  parseWizardYesNo,
  parseWizardCapOverrides,
  choicesFromNonInteractive,
} from ${JSON.stringify(join(ROOT, "src", "commands", "setup-wizard.ts"))};
export { ALL_PRESETS } from ${JSON.stringify(join(ROOT, "src", "harness", "modes.ts"))};
export { METRIC_DEFS, formatMetricDefaultRow } from ${JSON.stringify(join(ROOT, "src", "harness", "metric-caps.ts"))};
`;

const NODE_STUB = `
const refuse = (name) => () => { throw new Error("node builtin " + name + " is not available in the demo bundle"); };
export const existsSync = () => false;
export const readFileSync = refuse("fs.readFileSync");
export const writeFileSync = refuse("fs.writeFileSync");
export const mkdirSync = refuse("fs.mkdirSync");
export const appendFileSync = refuse("fs.appendFileSync");
export const statSync = refuse("fs.statSync");
export const readdirSync = () => [];
export const join = (...parts) => parts.filter(Boolean).join("/");
export const dirname = (p) => p.split("/").slice(0, -1).join("/") || "/";
export const resolve = (...parts) => parts.filter(Boolean).join("/");
export const relative = (_from, to) => to;
export const isAbsolute = (p) => typeof p === "string" && p.startsWith("/");
export const basename = (p) => p.split("/").pop() ?? p;
export default {};
`;

export async function generateDemoHtml(): Promise<string> {
	const bundle = await build({
		stdin: { contents: ENTRY, resolveDir: ROOT, loader: "ts" },
		bundle: true,
		write: false,
		format: "iife",
		globalName: "InterlinkedWizard",
		platform: "browser",
		target: "es2022",
		// Determinism: no minify (stable identifier names across esbuild patch
		// versions matter less unminified), no sourcemap, no banner timestamps.
		minify: false,
		sourcemap: false,
		plugins: [
			{
				name: "node-builtin-stub",
				setup(b) {
					b.onResolve({ filter: /^node:/ }, (args) => ({
						path: args.path,
						namespace: "node-stub",
					}));
					b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
						contents: NODE_STUB,
						loader: "js",
					}));
				},
			},
		],
	});
	const js = bundle.outputFiles?.[0]?.text;
	if (!js) throw new Error("esbuild produced no output");
	// `globalName` attaches to the iife's `var` — hoist onto globalThis so the
	// template's glue script (a separate <script>) can read it.
	const attached = `${js}\nglobalThis.InterlinkedWizard = InterlinkedWizard;`;
	const template = readFileSync(TEMPLATE, "utf-8");
	if (!template.includes(PLACEHOLDER)) {
		throw new Error(`template is missing the ${PLACEHOLDER} placeholder`);
	}
	return template.replace(PLACEHOLDER, () => attached);
}

const isCheck = process.argv.includes("--check");
const html = await generateDemoHtml();
if (isCheck) {
	let committed = "";
	try {
		committed = readFileSync(OUT, "utf-8");
	} catch {
		console.error(`[demo-check] ${OUT} does not exist — run the generator.`);
		process.exit(1);
	}
	if (committed !== html) {
		console.error(
			"[demo-check] docs/demo/onboarding-demo.html is STALE relative to the wizard module. " +
				"Regenerate: npx tsx scripts/gen-onboarding-demo.mts",
		);
		process.exit(1);
	}
	console.log("[demo-check] demo is in sync with setup-wizard.ts");
} else {
	writeFileSync(OUT, html);
	console.log(`[demo] wrote ${OUT} (${(html.length / 1024).toFixed(1)} KB)`);
}
