// interlinked-tdd: exempt
// ===========================================
// Software Version Regression — version parsing & comparison helpers
// ===========================================
// Leaf helpers split out of software-version-regression.ts: model/version
// string parsing, comparability checks, provider classification, and the
// regression comparison. Pure functions — they depend only on their own
// logic, the regexes below, and the (type-only) SoftwareVersionReference
// shape imported from the parent module.

import type { SoftwareVersionReference } from "./software-version-regression.js";

interface ComparableVersion {
	kind: "number" | "date" | "model";
	parts: number[];
}

// `o(?=\d)` matches OpenAI's o-series prefix (`o1`, `o3`, …) without
// matching bare `o` tokens. Without the lookahead, `\bo\b` matched the
// `o` in Unix shell flags like `-o ro` and `--read-only`, causing
// freshness-sensitive false positives on any content that mentioned
// shell-flag syntax (e.g., mount, ssh, curl).
export const MODEL_PROVIDER_RE =
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

// The disciplined model-identifier shape: an optional namespace, then either
// a provider word joined by `-`/`.` to family/version tokens, or OpenAI's
// compact o-series form (`o3`, `o4-mini`). The whole match must contain at
// least one digit and the provider must not be followed by a file extension.
const MODEL_IDENTIFIER_RE =
	/(?:^|[\s"'`(=:,/])(?<model>(?:[a-z][\w.-]*\/)?(?:(?:gpt|claude|gemini|llama|mistral|mixtral|qwen|deepseek|command-r|nova|o)[-.][\w.-]*\d[\w.-]*|o(?=\d)[\w.-]*\d[\w.-]*))\b/i;

// True only when `value` contains a token shaped like a real model
// identifier (provider + family/version), not a bare provider substring
// embedded in a filename, path, or kebab-case slug.
export function looksLikeModelIdentifier(value: string): boolean {
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

export function classifyGenericKind(
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

export function isVersionRegression(
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

export function looksComparable(value: string, kind: SoftwareVersionReference["kind"] = "generic"): boolean {
	return Boolean(
		parseDateVersion(value) ||
			(kind === "model" && parseNamedModelVersion(value)) ||
			parseModelVersion(value) ||
			parseNumericVersion(value),
	);
}

export function modelProviderOf(value: string): string | undefined {
	const match = MODEL_PROVIDER_RE.exec(value);
	return (match?.groups?.provider ?? match?.groups?.oseries)?.toLowerCase();
}

export function modelFamilyOf(value: string): string | undefined {
	const lower = value.toLowerCase();
	const provider = modelProviderOf(lower);
	if (provider) return provider;
	const family = lower
		.replace(/(?:^|[-_.])v?\d+(?:[.-]\d+)*(?:[-_.]?[a-z]+)?$/i, "")
		.replace(/[-_.]+$/g, "");
	return family || undefined;
}

export function providerDisplayName(provider: string | undefined): string | undefined {
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
