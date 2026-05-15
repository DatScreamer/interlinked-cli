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

// `o(?=\d)` matches OpenAI's o-series prefix (`o1`, `o3`, …) without
// matching bare `o` tokens. Without the lookahead, `\bo\b` matched the
// `o` in Unix shell flags like `-o ro` and `--read-only`, causing
// freshness-sensitive false positives on any content that mentioned
// shell-flag syntax (e.g., mount, ssh, curl).
const MODEL_PROVIDER_RE =
	/\b(?:(?<provider>gpt|claude|gemini|llama|mistral|mixtral|qwen|deepseek|command-r|nova)\b|(?<oseries>o)(?=\d))/i;

// A bare provider word (`claude`, `gpt`, …) is NOT a model identifier on its
// own. `CLAUDE.md`, `.claude/skills/...`, and kebab-case slugs like
// `enforce-claude-no-cypress` all contain the substring "claude" but are a
// filename, a path, and a rule id respectively — none are model names.
// A real model identifier has a recognizable shape: a provider token joined
// by `-` or `.` to a model family and at least one numeric version/date
// component (e.g. `claude-opus-4-7`, `claude-3-5-sonnet-20241022`,
// `gpt-4-0613`, `gemini-1.5-pro`). `looksLikeModelIdentifier` requires that
// shape so value-driven model classification can't fire on filenames,
// paths, or identifiers that merely embed a provider word.
//
// File extensions that disqualify a provider-prefixed token from being a
// model identifier (`CLAUDE.md` -> not a model).
const NON_MODEL_EXTENSION_RE =
	/\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|cedar|html|css|sh|py|rs|go|lock|local)\b/i;

// The disciplined model-identifier shape: an optional namespace, then a
// provider word, then `-`/`.` joined family/version tokens. The whole match
// must contain at least one digit (enforced separately) and the provider
// must not be followed by a file extension.
const MODEL_IDENTIFIER_RE =
	/(?:^|[\s"'`(=:,/])(?<model>(?:[a-z][\w.-]*\/)?(?:gpt|claude|gemini|llama|mistral|mixtral|qwen|deepseek|command-r|nova|o)[-.][\w.-]*\d[\w.-]*)\b/i;

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
	const pathByLine = computeObjectPathByLine(content, lines.length);
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

		for (const ref of collectGenericAssignmentRefs(line, lineNo, pathByLine[i] ?? "")) {
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

function collectGenericAssignmentRefs(
	line: string,
	lineNo: number,
	objectPath: string,
): SoftwareVersionReference[] {
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
			const baseAnchor =
				kind === "model"
					? `model:${key.toLowerCase()}:${modelFamily ?? modelProvider ?? "unknown"}`
					: `${kind}:${key.toLowerCase()}`;
			const anchor = objectPath ? `${baseAnchor}@${objectPath}` : baseAnchor;
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

// Walk content once tracking object/array nesting so each line gets a parent
// key chain (e.g. "dependencies.lodash"). Without this, every "version" key in
// a lockfile maps to the same anchor and unchanged nested versions are wrongly
// compared against the first occurrence.
function computeObjectPathByLine(content: string, lineCount: number): string[] {
	const out = new Array<string>(lineCount).fill("");
	const stack: string[] = [];
	let lastKey: string | undefined;
	let lineIndex = 0;
	let inString = false;
	let stringQuote = "";
	let stringStart = -1;
	let escape = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];

		if (ch === "\n") {
			out[lineIndex] = stack.join(".");
			lineIndex++;
			if (lineIndex >= lineCount) break;
			continue;
		}

		if (inString) {
			if (escape) {
				escape = false;
			} else if (ch === "\\") {
				escape = true;
			} else if (ch === stringQuote) {
				inString = false;
				const literal = content.slice(stringStart + 1, i);
				let j = i + 1;
				while (j < content.length && (content[j] === " " || content[j] === "\t")) j++;
				if (content[j] === ":") lastKey = literal;
			}
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringQuote = ch;
			stringStart = i;
			continue;
		}

		if (ch === "{" || ch === "[") {
			stack.push(lastKey ?? (ch === "[" ? "[]" : "{}"));
			lastKey = undefined;
		} else if (ch === "}" || ch === "]") {
			stack.pop();
			lastKey = undefined;
		}
	}

	if (lineIndex < lineCount) out[lineIndex] = stack.join(".");
	return out;
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

// True only when `value` contains a token shaped like a real model
// identifier (provider + family/version), not a bare provider substring
// embedded in a filename, path, or kebab-case slug.
function looksLikeModelIdentifier(value: string): boolean {
	MODEL_IDENTIFIER_RE.lastIndex = 0;
	const match = MODEL_IDENTIFIER_RE.exec(value);
	const model = match?.groups?.model;
	if (!model) return false;
	// `claude.md`, `gpt.json` etc. — the provider word is a filename stem,
	// not a model family. Reject when a non-model extension follows the
	// provider directly.
	if (NON_MODEL_EXTENSION_RE.test(model)) return false;
	return true;
}

function classifyGenericKind(
	key: string,
	value: string,
): SoftwareVersionReference["kind"] {
	// Key-driven classification (`model: "..."`, `modelName: "..."`) stays —
	// the key explicitly declares intent. Value-driven classification now
	// requires a real model-identifier shape so it can't fire on `CLAUDE.md`,
	// `.claude/...` paths, or `enforce-claude-*` rule ids.
	if (/model/i.test(key) || looksLikeModelIdentifier(value)) return "model";
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
	const match = MODEL_PROVIDER_RE.exec(value);
	return (match?.groups?.provider ?? match?.groups?.oseries)?.toLowerCase();
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
	// Strip the @<objectPath> suffix from anchor for freshness comparison.
	// The objectPath component is position-dependent (computed by walking
	// the file's JSON nesting structure line-by-line), so inserting content
	// earlier in a file changes the objectPath for unchanged content
	// downstream — making previously-seen references look "new" in the
	// before/after diff and firing freshness warnings on content that was
	// already there. The base anchor (kind:key:family) is position-
	// independent and is the right granularity for "have we seen this
	// reference before?". Regressions detection keeps the full anchor
	// because it needs to track the same package at different nesting
	// paths (e.g., dependencies.lodash vs devDependencies.lodash)
	// independently.
	const atIdx = ref.anchor.indexOf("@");
	const baseAnchor = atIdx === -1 ? ref.anchor : ref.anchor.slice(0, atIdx);
	return `${baseAnchor}\0${ref.version}`;
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
