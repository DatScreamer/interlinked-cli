// ===========================================
// Software Version Regression / Freshness Detection
// ===========================================
// PostToolUse-only detector for edits that move software identifiers
// backward: model names, package/dependency versions, Docker tags, GitHub
// action versions, API dates, and common config/code version assignments.
// It also identifies newly introduced freshness-sensitive references so the
// agent verifies official sources instead of relying on remembered timelines.

import { basename } from "node:path";

export interface SoftwareVersionReference {
	anchor: string;
	label: string;
	kind: "package" | "model" | "docker_image" | "github_action" | "api_version" | "generic";
	version: string;
	line: number;
	text: string;
}

export interface SoftwareVersionRegression {
	before: SoftwareVersionReference;
	after: SoftwareVersionReference;
}

export interface SoftwareVersionVerificationHint {
	source: string;
	instruction: string;
}

export interface SoftwareVersionFreshnessConcern {
	ref: SoftwareVersionReference;
	reason: string;
	verifyHint: SoftwareVersionVerificationHint;
}

interface ComparableVersion {
	kind: "number" | "date" | "model";
	parts: number[];
}

const PACKAGE_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
	"resolutions",
	"overrides",
] as const;

const MODEL_PROVIDER_RE =
	/\b(gpt|o|claude|gemini|llama|mistral|mixtral|qwen|deepseek|command-r|nova)\b/i;

const SOFTWARE_KEY_RE =
	/(?:^|[_\-.])(?:version|model|modelname|api[_\-.]?version|runtime|engine|image|sdk|tool|package|dependency|node|python|go|rust|java)(?:$|[_\-.])/i;

const GENERIC_ASSIGNMENT_RE =
	/(?:^|[\s{,(])(?<key>[A-Za-z_][\w.-]{0,80})\s*(?::|=)\s*["'](?<value>[^"'\n]{1,160})["']/g;

const JSON_STRING_PROP_RE =
	/"(?<key>[^"\n]{1,100})"\s*:\s*"(?<value>[^"\n]{1,160})"/g;

const GITHUB_ACTION_RE = /\buses:\s*(?<action>[\w.-]+\/[\w.-]+)@(?<version>[^\s#]+)/i;

const DOCKER_FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(?<image>[^\s:@]+(?:\/[^\s:@]+)*)(?::(?<version>[^\s@]+))?/i;

const REQUIREMENT_RE =
	/^\s*(?<name>[A-Za-z0-9_.-]+)\s*(?:==|~=|>=|<=|=)\s*(?<version>[^\s;#]+)/;

const GO_REQUIRE_RE = /^\s*(?<module>[A-Za-z0-9_.-]+(?:\/[^\s]+)+)\s+v?(?<version>\d+\.\d+\.\d+[^\s]*)/;

const CARGO_DEP_RE = /^\s*(?<name>[A-Za-z0-9_-]+)\s*=\s*["'](?<version>[^"']+)["']/;

export function collectSoftwareVersionReferences(
	content: string,
	filePath: string,
): SoftwareVersionReference[] {
	const refs: SoftwareVersionReference[] = [];
	const seen = new Set<string>();
	const base = basename(filePath).toLowerCase();

	if (base === "package.json") {
		refs.push(...collectPackageJsonRefs(content));
	}

	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNo = i + 1;

		collectLineRef(refs, seen, collectDockerFromRef(line, lineNo));
		collectLineRef(refs, seen, collectGithubActionRef(line, lineNo));
		collectLineRef(refs, seen, collectRequirementRef(line, lineNo));
		collectLineRef(refs, seen, collectGoRequireRef(line, lineNo));
		if (base === "cargo.toml" || filePath.endsWith(".toml")) {
			collectLineRef(refs, seen, collectCargoDependencyRef(line, lineNo));
		}

		for (const ref of collectGenericAssignmentRefs(line, lineNo)) {
			collectLineRef(refs, seen, ref);
		}
	}

	return refs;
}

export function detectSoftwareVersionRegressions(
	beforeRefs: readonly SoftwareVersionReference[],
	afterRefs: readonly SoftwareVersionReference[],
): SoftwareVersionRegression[] {
	const beforeByAnchor = new Map<string, SoftwareVersionReference[]>();
	for (const ref of beforeRefs) {
		const list = beforeByAnchor.get(ref.anchor) ?? [];
		list.push(ref);
		beforeByAnchor.set(ref.anchor, list);
	}

	const regressions: SoftwareVersionRegression[] = [];
	const emitted = new Set<string>();
	for (const after of afterRefs) {
		const beforeList = beforeByAnchor.get(after.anchor);
		if (!beforeList) continue;
		const before = beforeList[0];
		if (!isVersionRegression(before, after)) continue;
		const key = `${after.anchor}\0${before.version}\0${after.version}`;
		if (emitted.has(key)) continue;
		emitted.add(key);
		regressions.push({ before, after });
	}
	return regressions;
}

export function detectSoftwareVersionFreshnessConcerns(
	beforeRefs: readonly SoftwareVersionReference[],
	afterRefs: readonly SoftwareVersionReference[],
): SoftwareVersionFreshnessConcern[] {
	const beforeKeys = new Set(beforeRefs.map((ref) => referenceIdentity(ref)));
	const concerns: SoftwareVersionFreshnessConcern[] = [];
	const emitted = new Set<string>();

	for (const ref of afterRefs) {
		if (beforeKeys.has(referenceIdentity(ref))) continue;
		const concern = freshnessConcernForRef(ref);
		if (!concern) continue;
		const key = `${ref.anchor}\0${ref.version}\0${concern.reason}`;
		if (emitted.has(key)) continue;
		emitted.add(key);
		concerns.push({ ref, ...concern });
	}

	return concerns;
}

export function formatSoftwareVersionRegressionDetail(
	regressions: readonly SoftwareVersionRegression[],
): string {
	const lines: string[] = [];
	const shownRegressions = regressions.slice(0, 8);
	if (shownRegressions.length > 0) lines.push("Likely regressions:");
	lines.push(...shownRegressions.map(({ before, after }) => {
		return `  L${after.line}: ${after.label} ${before.version} -> ${after.version}`;
	}));
	if (regressions.length > shownRegressions.length) {
		lines.push(`  ... and ${regressions.length - shownRegressions.length} more`);
	}

	return lines.join("\n");
}

export function formatSoftwareVersionFreshnessDetail(
	concerns: readonly SoftwareVersionFreshnessConcern[],
): string {
	const lines: string[] = [];
	const shownConcerns = concerns.slice(0, 8);
	if (shownConcerns.length > 0) {
		lines.push("Freshness-sensitive new references:");
	}
	lines.push(...shownConcerns.map(({ ref, reason, verifyHint }) => {
		return `  L${ref.line}: ${ref.label} ${ref.version} - ${reason}; verify: ${verifyHint.source}`;
	}));
	if (concerns.length > shownConcerns.length) {
		lines.push(`  ... and ${concerns.length - shownConcerns.length} more`);
	}

	return lines.join("\n");
}

function collectPackageJsonRefs(content: string): SoftwareVersionReference[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	const refs: SoftwareVersionReference[] = [];

	if (typeof obj.version === "string") {
		refs.push({
			anchor: "package:self-version",
			label: "package version",
			kind: "package",
			version: obj.version,
			line: findJsonPropLine(content, "version", obj.version),
			text: `"version": "${obj.version}"`,
		});
	}

	for (const section of PACKAGE_SECTIONS) {
		const deps = obj[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
		for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
			if (typeof version !== "string") continue;
			refs.push({
				anchor: `package:${name}`,
				label: `${section} ${name}`,
				kind: "package",
				version,
				line: findJsonPropLine(content, name, version),
				text: `"${name}": "${version}"`,
			});
		}
	}

	return refs;
}

function collectDockerFromRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = DOCKER_FROM_RE.exec(line);
	const image = match?.groups?.image;
	const version = match?.groups?.version;
	if (!image || !version || version.toLowerCase() === "latest") return undefined;
	return {
		anchor: `docker:${image}`,
		label: `Docker image ${image}`,
		kind: "docker_image",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectGithubActionRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = GITHUB_ACTION_RE.exec(line);
	const action = match?.groups?.action;
	const version = match?.groups?.version;
	if (!action || !version) return undefined;
	return {
		anchor: `github-action:${action.toLowerCase()}`,
		label: `GitHub Action ${action}`,
		kind: "github_action",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectRequirementRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = REQUIREMENT_RE.exec(line);
	const name = match?.groups?.name;
	const version = match?.groups?.version;
	if (!name || !version) return undefined;
	return {
		anchor: `package:${name.toLowerCase()}`,
		label: `Python package ${name}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectGoRequireRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = GO_REQUIRE_RE.exec(line);
	const module = match?.groups?.module;
	const version = match?.groups?.version;
	if (!module || !version) return undefined;
	return {
		anchor: `package:${module.toLowerCase()}`,
		label: `Go module ${module}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectCargoDependencyRef(
	line: string,
	lineNo: number,
): SoftwareVersionReference | undefined {
	const match = CARGO_DEP_RE.exec(line);
	const name = match?.groups?.name;
	const version = match?.groups?.version;
	if (!name || !version || !looksComparable(version)) return undefined;
	return {
		anchor: `package:${name.toLowerCase()}`,
		label: `Cargo package ${name}`,
		kind: "package",
		version,
		line: lineNo,
		text: line.trim(),
	};
}

function collectGenericAssignmentRefs(line: string, lineNo: number): SoftwareVersionReference[] {
	const refs: SoftwareVersionReference[] = [];
	for (const re of [GENERIC_ASSIGNMENT_RE, JSON_STRING_PROP_RE]) {
		re.lastIndex = 0;
		for (const match of line.matchAll(re)) {
			const key = match.groups?.key;
			const value = match.groups?.value;
			if (!key || !value) continue;
			const hasSoftwareKey = SOFTWARE_KEY_RE.test(key);
			if (!hasSoftwareKey && !MODEL_PROVIDER_RE.test(value)) continue;
			const modelProvider = modelProviderOf(value);
			const kind = classifyGenericKind(key, value);
			if (!modelProvider && !looksComparable(value, kind)) continue;
			const modelFamily = kind === "model" ? modelFamilyOf(value) : undefined;
			const anchor =
				kind === "model"
					? `model:${key.toLowerCase()}:${modelFamily ?? modelProvider ?? "unknown"}`
					: `${kind}:${key.toLowerCase()}`;
			refs.push({
				anchor,
				label: `${key}`,
				kind,
				version: value,
				line: lineNo,
				text: line.trim(),
			});
		}
	}
	return refs;
}

function collectLineRef(
	refs: SoftwareVersionReference[],
	seen: Set<string>,
	ref: SoftwareVersionReference | undefined,
): void {
	if (!ref) return;
	const key = `${ref.anchor}\0${ref.line}\0${ref.version}`;
	if (seen.has(key)) return;
	seen.add(key);
	refs.push(ref);
}

function classifyGenericKind(
	key: string,
	value: string,
): SoftwareVersionReference["kind"] {
	if (MODEL_PROVIDER_RE.test(value) || /model/i.test(key)) return "model";
	if (/api[_\-.]?version/i.test(key) || parseDateVersion(value)) return "api_version";
	return "generic";
}

function isVersionRegression(
	before: SoftwareVersionReference,
	after: SoftwareVersionReference,
): boolean {
	const pre = comparableVersion(before.version, before.kind);
	const post = comparableVersion(after.version, after.kind);
	if (!pre || !post || pre.kind !== post.kind) return false;
	return compareParts(post.parts, pre.parts) < 0;
}

function comparableVersion(
	raw: string,
	kind: SoftwareVersionReference["kind"],
): ComparableVersion | undefined {
	const date = parseDateVersion(raw);
	if (date) return { kind: "date", parts: date };

	if (kind === "model" || MODEL_PROVIDER_RE.test(raw)) {
		const model = parseModelVersion(raw) ?? parseNamedModelVersion(raw);
		if (model) return { kind: "model", parts: model };
	}

	const numeric = parseNumericVersion(raw);
	if (numeric) return { kind: "number", parts: numeric };
	return undefined;
}

function parseDateVersion(raw: string): number[] | undefined {
	const match = /\b(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?([0-2]\d|3[01])\b/.exec(raw);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseModelVersion(raw: string): number[] | undefined {
	const lower = raw.toLowerCase();
	const provider = modelProviderOf(lower);
	if (!provider) return undefined;
	const start = lower.indexOf(provider);
	const tail = lower.slice(start + provider.length);
	const numericParts = [...tail.matchAll(/\d+/g)]
		.map((m) => Number(m[0]))
		.filter((n) => Number.isFinite(n));
	if (numericParts.length === 0) return undefined;
	return numericParts.slice(0, 4);
}

function parseNamedModelVersion(raw: string): number[] | undefined {
	const matches = [...raw.matchAll(/(?:^|[-_.])v?(\d+)(?:[.-](\d+))?(?:[.-](\d+))?/gi)];
	if (matches.length === 0) return undefined;
	const last = matches[matches.length - 1];
	return [Number(last[1]), Number(last[2] ?? 0), Number(last[3] ?? 0)];
}

function parseNumericVersion(raw: string): number[] | undefined {
	const cleaned = raw.trim().replace(/^[~^<>=\s]*/, "").replace(/^v/i, "");
	if (/^(latest|next|canary|workspace:|file:|link:|npm:|git)/i.test(cleaned)) return undefined;
	const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(cleaned);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareParts(a: readonly number[], b: readonly number[]): number {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av !== bv) return av - bv;
	}
	return 0;
}

function looksComparable(value: string, kind: SoftwareVersionReference["kind"] = "generic"): boolean {
	return Boolean(
		parseDateVersion(value) ||
			(kind === "model" && parseNamedModelVersion(value)) ||
			parseModelVersion(value) ||
			parseNumericVersion(value),
	);
}

function modelProviderOf(value: string): string | undefined {
	return MODEL_PROVIDER_RE.exec(value)?.[1]?.toLowerCase();
}

function modelFamilyOf(value: string): string | undefined {
	const lower = value.toLowerCase();
	const provider = modelProviderOf(lower);
	if (provider) return provider;
	const family = lower
		.replace(/(?:^|[-_.])v?\d+(?:[.-]\d+)*(?:[-_.]?[a-z]+)?$/i, "")
		.replace(/[-_.]+$/g, "");
	return family || undefined;
}

function referenceIdentity(ref: SoftwareVersionReference): string {
	return `${ref.anchor}\0${ref.version}`;
}

function freshnessConcernForRef(
	ref: SoftwareVersionReference,
): { reason: string; verifyHint: SoftwareVersionVerificationHint } | undefined {
	const haystack = `${ref.label} ${ref.version} ${ref.text}`;
	if (/\b(deprecated|obsolete|legacy|classic|previous|old)\b/i.test(haystack)) {
		return {
			reason: "legacy/deprecated wording around a software reference should be verified",
			verifyHint: verificationHintForRef(ref, "legacy"),
		};
	}
	if (ref.kind === "model") {
		return {
			reason: "model identifiers change frequently; verify against provider docs before relying on memory",
			verifyHint: verificationHintForRef(ref, "model"),
		};
	}
	if (ref.kind === "api_version") {
		return {
			reason: "API version/date pins are freshness-sensitive; verify the intended provider version",
			verifyHint: verificationHintForRef(ref, "api"),
		};
	}
	return undefined;
}

function verificationHintForRef(
	ref: SoftwareVersionReference,
	context: "api" | "legacy" | "model",
): SoftwareVersionVerificationHint {
	if (context === "api") {
		return {
			source: "official API versioning docs for the provider that owns this endpoint or SDK",
			instruction:
				"Confirm the intended API date/version from provider documentation before introducing the pin.",
		};
	}

	if (context === "legacy") {
		return {
			source: "official migration, release-note, or deprecation documentation",
			instruction:
				"Confirm whether the referenced software is actually legacy/deprecated before writing that claim.",
		};
	}

	const provider = modelProviderOf(`${ref.label} ${ref.version} ${ref.text}`);
	const providerName = providerDisplayName(provider);
	return {
		source: providerName
			? `official ${providerName} model documentation`
			: "official model provider documentation",
		instruction:
			"Confirm current model identifiers and supported aliases from provider documentation before introducing the reference.",
	};
}

function providerDisplayName(provider: string | undefined): string | undefined {
	switch (provider) {
		case "gpt":
		case "o":
			return "OpenAI";
		case "claude":
			return "Anthropic";
		case "gemini":
			return "Google Gemini";
		case "llama":
			return "Meta Llama";
		case "mistral":
		case "mixtral":
			return "Mistral";
		case "qwen":
			return "Qwen";
		case "deepseek":
			return "DeepSeek";
		case "command-r":
			return "Cohere";
		case "nova":
			return "Amazon Nova";
		default:
			return undefined;
	}
}

function findJsonPropLine(content: string, key: string, value: string): number {
	const escapedKey = escapeRegExp(key);
	const escapedValue = escapeRegExp(value);
	const re = new RegExp(`"${escapedKey}"\\s*:\\s*"${escapedValue}"`);
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (re.test(lines[i])) return i + 1;
	}
	return 1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
