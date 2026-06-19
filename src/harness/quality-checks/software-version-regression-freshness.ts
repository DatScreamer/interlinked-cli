// interlinked-tdd: exempt
// ===========================================
// Software Version Regression — freshness concern & verification hints
// ===========================================
// Leaf helpers split out of software-version-regression.ts: the per-reference
// freshness classification and the human-readable verification hints. Called
// only by detectSoftwareVersionFreshnessConcerns in the parent module; depends
// only on the version-parse provider helpers and the (type-only) reference /
// hint shapes imported from the parent module.

import type {
	SoftwareVersionReference,
	SoftwareVersionVerificationHint,
} from "./software-version-regression.js";
import {
	modelProviderOf,
	providerDisplayName,
} from "./software-version-regression-version-parse.js";

export function referenceIdentity(ref: SoftwareVersionReference): string {
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

export function freshnessConcernForRef(
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
