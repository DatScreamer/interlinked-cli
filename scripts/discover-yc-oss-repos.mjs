#!/usr/bin/env node
// Discover open-source GitHub repositories belonging to YC companies.
//
// Reads batches from yc-oss/api (newest first), tries to map each company to
// a GitHub org/user, lists their public non-fork repos with recent activity,
// and writes a discovery list to reference-repos/y-combinator/discovered.json.
//
// Usage:
//   node scripts/discover-yc-oss-repos.mjs [--limit N] [--batch winter-2026] [--write-misses]
//
// Auth: relies on `gh auth` (uses `gh api` under the hood).

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BATCHES_NEWEST_FIRST = [
	"fall-2026",
	"summer-2026",
	"spring-2026",
	"winter-2026",
	"fall-2025",
	"summer-2025",
	"spring-2025",
	"winter-2025",
	"summer-2024",
	"fall-2024",
	"winter-2024",
	"summer-2023",
	"winter-2023",
];

// Languages our `interlinked verify` pipeline has strong checks for.
const SCANNABLE_LANGS = new Set([
	"TypeScript",
	"JavaScript",
	"Python",
	"Go",
	"Rust",
	"Java",
	"Ruby",
	"Swift",
	"C",
	"C++",
	"C#",
	"Elixir",
	"Kotlin",
	"PHP",
]);

const MS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86400;
const MS_PER_DAY = SECONDS_PER_DAY * MS_PER_SECOND;
const RECENT_DAYS = 365; // "appears used or updated semi frequently"
const MIN_REPO_SIZE_KB = 50;
const MAX_SECONDARY = 5;
const MAX_FETCH_BUFFER_BYTES = 4 * 1024 * 1024;
const REPO_ROOT = process.cwd();
const OUTPUT_DIR = join(REPO_ROOT, "reference-repos/y-combinator");
const OUTPUT_PATH = join(OUTPUT_DIR, "discovered.json");
const MISSES_PATH = join(OUTPUT_DIR, "misses.json");

const args = process.argv.slice(2);
function flag(name, def) {
	const i = args.indexOf(name);
	if (i < 0) return def;
	return args[i + 1] ?? true;
}
const LIMIT = parseInt(flag("--limit", "0"), 10) || Number.POSITIVE_INFINITY;
const BATCH_ONLY = flag("--batch", null);
const WRITE_MISSES = args.includes("--write-misses");

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		// reason: malformed JSON is an expected miss case; caller treats null as "skip".
		return null;
	}
}

function gh(path) {
	let out;
	try {
		out = execFileSync("gh", ["api", path], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		// reason: 404 / rate-limit / no-such-org is an expected miss; caller treats null as "skip candidate".
		return null;
	}
	return safeParse(out);
}

function fetchJson(url) {
	const out = execFileSync("curl", ["-fsSL", "-H", "Accept: application/json", url], {
		encoding: "utf-8",
	});
	const parsed = safeParse(out);
	if (parsed == null) {
		throw new Error(`Malformed JSON from ${url}`);
	}
	return parsed;
}

const WEBSITE_FETCH_TIMEOUT_S = 15;

function fetchWebsiteText(url) {
	try {
		return execFileSync(
			"curl",
			[
				"-fsSL",
				"--max-time",
				String(WEBSITE_FETCH_TIMEOUT_S),
				"-H",
				"Accept: text/markdown",
				"-A",
				"Mozilla/5.0 (compatible; interlinked-yc-discovery/1.0)",
				url,
			],
			{ encoding: "utf-8", maxBuffer: MAX_FETCH_BUFFER_BYTES },
		);
	} catch {
		// reason: SSL error / DNS / 404 / timeout — site unreachable is an expected outcome; caller treats null as "no website signal".
		return null;
	}
}

// GitHub login extraction from arbitrary text. Matches `github.com/<login>`
// and `github.com/<login>/<repo>`, then filters reserved GitHub paths that
// aren't user/org logins.
const GITHUB_LINK_RE = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?=[/?#"'\s)]|$)/gi;
const GITHUB_RESERVED_LOGINS = new Set([
	"about",
	"contact",
	"customer-stories",
	"enterprise",
	"events",
	"explore",
	"features",
	"home",
	"join",
	"login",
	"marketplace",
	"new",
	"organizations",
	"orgs",
	"pricing",
	"privacy",
	"pulls",
	"readme",
	"search",
	"security",
	"settings",
	"site",
	"sponsors",
	"stars",
	"team",
	"terms",
	"topics",
	"trending",
	"watching",
]);

export function extractGithubLogins(text) {
	if (!text) return [];
	const out = new Set();
	for (const m of text.matchAll(GITHUB_LINK_RE)) {
		const login = m[1].toLowerCase();
		if (GITHUB_RESERVED_LOGINS.has(login)) continue;
		out.add(login);
	}
	return [...out];
}

const GITHUB_LOGIN_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export function loginCandidates(company) {
	const slug = company.slug;
	const nameLower = company.name.toLowerCase();
	const candidates = new Set([
		slug,
		slug.replace(/-/g, ""),
		nameLower.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
		nameLower.replace(/\s+/g, "").replace(/[^a-z0-9]/g, ""),
	]);
	candidates.delete("");
	return [...candidates].filter((c) => GITHUB_LOGIN_RE.test(c));
}

function tryAccount(login) {
	// One call works for both orgs and users — the /users endpoint resolves both.
	return gh(`users/${login}`);
}

function listRepos(login) {
	const repos = gh(`users/${login}/repos?per_page=100&type=public&sort=pushed`);
	return Array.isArray(repos) ? repos : [];
}

export function isActiveRepo(repo, now = Date.now()) {
	if (repo.fork) return false;
	if (repo.archived) return false;
	if (repo.disabled) return false;
	if ((repo.size ?? 0) < MIN_REPO_SIZE_KB) return false;
	const cutoff = now - RECENT_DAYS * MS_PER_DAY;
	if (new Date(repo.pushed_at).getTime() < cutoff) return false;
	return true;
}

export function rankRepos(repos, now = Date.now()) {
	return repos.filter((r) => isActiveRepo(r, now)).sort((a, b) => {
		// Primary signal: recent push (active). Tie-break on stars.
		const pushDiff = new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime();
		if (pushDiff !== 0) return pushDiff;
		return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
	});
}

export function summarizeRepo(repo) {
	return {
		name: repo.name,
		full_name: repo.full_name,
		description: repo.description ?? null,
		language: repo.language ?? null,
		stars: repo.stargazers_count ?? 0,
		pushed_at: repo.pushed_at,
		size_kb: repo.size,
		default_branch: repo.default_branch,
		html_url: repo.html_url,
		scannable: SCANNABLE_LANGS.has(repo.language ?? ""),
	};
}

export function verifyMatch(account, company) {
	const companyHost = (() => {
		try {
			return new URL(company.website).hostname.replace(/^www\./, "");
		} catch {
			return null;
		}
	})();
	const accountFields = [
		account.blog,
		account.email,
		account.html_url,
		account.bio,
		account.description,
		account.name,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	const reasons = [];
	if (companyHost && accountFields.includes(companyHost)) {
		reasons.push(`website-match:${companyHost}`);
	}
	const nameLower = company.name.toLowerCase();
	if (nameLower && accountFields.includes(nameLower)) {
		reasons.push("name-match");
	}
	if ((account.login ?? "").toLowerCase() === company.slug) {
		reasons.push("slug-exact");
	}
	return reasons;
}

function buildDiscovery({ account, reasons, ranked, source }) {
	return {
		login: account.login,
		account_type: account.type,
		discovery_source: source,
		verification: reasons,
		primary: summarizeRepo(ranked[0]),
		secondary: ranked.slice(1, 1 + MAX_SECONDARY).map(summarizeRepo),
		repo_count_active: ranked.length,
	};
}

function tryCandidate(candidate, company, options) {
	const account = tryAccount(candidate);
	if (!account) return null;
	const reasons = verifyMatch(account, company);
	if (
		reasons.length === 0 &&
		account.login.toLowerCase() !== company.slug &&
		!options.implicitVerification
	) {
		return null;
	}
	if (options.implicitVerification && reasons.length === 0) {
		reasons.push(options.implicitVerification);
	}
	const ranked = rankRepos(listRepos(candidate));
	if (ranked.length === 0) return null;
	return buildDiscovery({ account, reasons, ranked, source: options.source });
}

function discoverViaSlug(company) {
	for (const candidate of loginCandidates(company)) {
		const found = tryCandidate(candidate, company, { source: "slug-candidate" });
		if (found) return found;
	}
	return null;
}

function discoverViaWebsite(company) {
	if (!company.website) return null;
	const html = fetchWebsiteText(company.website);
	if (!html) return null;
	const candidates = extractGithubLogins(html);
	for (const candidate of candidates) {
		const found = tryCandidate(candidate, company, {
			source: "website-link",
			implicitVerification: `website-link:${company.website}`,
		});
		if (found) return found;
	}
	return null;
}

function discoverCompany(company) {
	return discoverViaSlug(company) ?? discoverViaWebsite(company);
}

function loadExistingDiscoveries() {
	if (!existsSync(OUTPUT_PATH)) return [];
	const parsed = safeParse(readFileSync(OUTPUT_PATH, "utf-8"));
	return Array.isArray(parsed) ? parsed : [];
}

function recordCompany(company, found, state) {
	state.discovered.push({
		company: {
			name: company.name,
			slug: company.slug,
			batch: company.batch,
			website: company.website,
			one_liner: company.one_liner,
			team_size: company.team_size,
			industry: company.industry,
			subindustry: company.subindustry,
		},
		github: found,
	});
	state.seenSlugs.add(company.slug);
	state.hits++;
	// Persist incrementally so we don't lose progress on Ctrl-C.
	writeFileSync(OUTPUT_PATH, JSON.stringify(state.discovered, null, 2));
}

function processCompany(company, state) {
	if (state.seenSlugs.has(company.slug)) return;
	if (state.hits >= LIMIT) return;
	state.inspected++;
	process.stderr.write(`  ${company.slug.padEnd(40)} `);
	let found = null;
	try {
		found = discoverCompany(company);
	} catch (e) {
		console.error(`error: ${e.message}`);
		return;
	}
	if (!found) {
		console.error("·");
		if (WRITE_MISSES) {
			state.misses.push({ slug: company.slug, name: company.name, batch: company.batch });
		}
		return;
	}
	console.error(
		`✓ ${found.login} → ${found.primary.full_name} (${found.primary.language ?? "?"}, ${found.primary.stars}★) [${found.verification.join("|") || "n/a"}]`,
	);
	recordCompany(company, found, state);
}

function processBatch(batchSlug, state) {
	console.error(`\n=== ${batchSlug} ===`);
	let batch;
	try {
		batch = fetchJson(`https://yc-oss.github.io/api/batches/${batchSlug}.json`);
	} catch (e) {
		console.error(`  skip batch (fetch failed: ${e.message})`);
		return;
	}
	for (const company of batch) {
		if (state.hits >= LIMIT) return;
		processCompany(company, state);
	}
}

function main() {
	mkdirSync(OUTPUT_DIR, { recursive: true });
	const discovered = loadExistingDiscoveries();
	const state = {
		discovered,
		seenSlugs: new Set(discovered.map((e) => e.company.slug)),
		misses: [],
		inspected: 0,
		hits: 0,
	};
	const startedAt = Date.now();

	for (const batchSlug of BATCHES_NEWEST_FIRST) {
		if (BATCH_ONLY && batchSlug !== BATCH_ONLY) continue;
		if (state.hits >= LIMIT) break;
		processBatch(batchSlug, state);
	}

	if (WRITE_MISSES) {
		writeFileSync(MISSES_PATH, JSON.stringify(state.misses, null, 2));
	}

	const elapsed = ((Date.now() - startedAt) / MS_PER_SECOND).toFixed(1);
	console.error(
		`\nInspected ${state.inspected} companies in ${elapsed}s · hits=${state.hits} · output: ${OUTPUT_PATH}`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
