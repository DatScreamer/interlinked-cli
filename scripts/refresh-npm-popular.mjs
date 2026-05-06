#!/usr/bin/env node
// Refresh weekly-download counts in
// `src/harness/checks/data/npm-popular-packages.json` from the npm registry.
//
// Usage:
//   node scripts/refresh-npm-popular.mjs                 # default behavior
//   node scripts/refresh-npm-popular.mjs --prune-below=10000   # drop low-traffic entries
//   node scripts/refresh-npm-popular.mjs --concurrency=8       # tune fetch parallelism
//
// What it does:
//   1. Read the JSON file.
//   2. For each `packages[].name`, fetch
//      https://api.npmjs.org/downloads/point/last-week/<name>
//   3. Update `weekly_downloads` in place. Set to 0 if the request returns
//      404 (package doesn't exist) or a stable error.
//   4. Sort packages by weekly_downloads descending; nulls go last.
//   5. Optionally prune entries below `--prune-below`.
//   6. Update `generated_at` to today's date.
//   7. Write back with stable formatting (2-space indent, sorted by downloads).
//
// The script is intentionally separate from the harness — it touches the
// network and is meant to run periodically (manual or CI cron), not on every
// edit.

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const FILE_PATH = resolve(
	process.cwd(),
	"src/harness/checks/data/npm-popular-packages.json",
);

function parseArgs(argv) {
	const out = { pruneBelow: null, concurrency: 6 };
	for (const arg of argv) {
		if (arg.startsWith("--prune-below=")) {
			out.pruneBelow = Number(arg.split("=")[1]);
		} else if (arg.startsWith("--concurrency=")) {
			out.concurrency = Math.max(1, Number(arg.split("=")[1]));
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: node scripts/refresh-npm-popular.mjs [options]

Options:
  --prune-below=N    Drop entries with weekly_downloads < N
  --concurrency=N    Parallel fetches (default: 6)
  --help             This message
`);
			process.exit(0);
		}
	}
	return out;
}

async function fetchWeeklyDownloads(name) {
	const url = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`;
	const res = await fetch(url);
	if (res.status === 404) return 0;
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
	const data = await res.json();
	return typeof data.downloads === "number" ? data.downloads : 0;
}

async function refresh(packages, concurrency) {
	const results = [];
	let cursor = 0;
	async function worker() {
		while (cursor < packages.length) {
			const idx = cursor++;
			const pkg = packages[idx];
			try {
				pkg.weekly_downloads = await fetchWeeklyDownloads(pkg.name);
				results.push({ name: pkg.name, downloads: pkg.weekly_downloads });
			} catch (err) {
				console.error(`  ! ${pkg.name}: ${err.message}`);
			}
		}
	}
	const workers = Array.from({ length: concurrency }, () => worker());
	await Promise.all(workers);
	return results;
}

function comparePackages(a, b) {
	const ad = a.weekly_downloads;
	const bd = b.weekly_downloads;
	// nulls last
	if (ad === null && bd === null) return a.name.localeCompare(b.name);
	if (ad === null) return 1;
	if (bd === null) return -1;
	return bd - ad;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const raw = await readFile(FILE_PATH, "utf-8");
	const json = JSON.parse(raw);
	if (!Array.isArray(json.packages)) {
		throw new Error(`Malformed file: missing packages array`);
	}

	console.log(
		`Refreshing ${json.packages.length} package download counts (concurrency=${opts.concurrency})...`,
	);
	await refresh(json.packages, opts.concurrency);

	if (opts.pruneBelow !== null && Number.isFinite(opts.pruneBelow)) {
		const before = json.packages.length;
		json.packages = json.packages.filter(
			(p) => p.weekly_downloads === null || p.weekly_downloads >= opts.pruneBelow,
		);
		console.log(
			`Pruned ${before - json.packages.length} entries below ${opts.pruneBelow} weekly downloads`,
		);
	}

	json.packages.sort(comparePackages);
	json.generated_at = new Date().toISOString().slice(0, 10);

	const out = `${JSON.stringify(json, null, "\t")}\n`;
	await writeFile(FILE_PATH, out, "utf-8");
	console.log(`Wrote ${FILE_PATH} (${json.packages.length} packages)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
