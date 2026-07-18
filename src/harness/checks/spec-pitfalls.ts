// Spec pitfall lexicon (docs/design/spec-audit-runtime-checks.md §7.5,
// spike 6): curated, citation-backed recurring spec falsehoods — the prose
// analog of the 2026-06 bug-class program. Seeded from the Sol Ultra
// FrankenGraphDB audit corpus (docs/external-pulse/sol-ultra-plan-audit.md).
// Advisory ALWAYS: each entry flags a claim shape that is usually — not
// provably — wrong; the fix instruction says what to verify, never rewrites.
//
// Growth loop: when a Tier-3/human review finding recurs (recurrence log →
// proposeAction → scaffold_rule), it graduates into this table with ≥3
// positive and ≥3 negative cases.

import {
	extractClaimSentences,
	extractFencedBlocks,
	fencedLineSet,
} from "../spec/extract-misc.js";
import { isSpecEligibleFile, siteText } from "../spec/types.js";
import type { InlineMatch } from "./shared.js";

interface PitfallEntry {
	id: string;
	/** All patterns must appear on the SAME LINE for the entry to fire. */
	patterns: RegExp[];
	/** Negative pattern: the line is exempt when this matches (hedged text). */
	unless?: RegExp;
	rationale: string;
	citation: string;
}

/** Sol-corpus seed entries (audit finding ids in comments). */
const PITFALLS: PitfallEntry[] = [
	{
		// Q-13: durable retry gives at-least-once; exactly-once needs a
		// transactional sink or idempotency key.
		id: "exactly_once_external",
		patterns: [/exactly[- ]once/i, /\b(?:webhook|external|third[- ]party|sink|trigger|delivery|notification)/i],
		unless: /at[- ]least[- ]once|idempoten|transactional sink|outbox/i,
		rationale:
			"'Exactly-once' delivery to an external system is not achievable with durable retry alone — that gives at-least-once. It needs a transactional sink or a stable idempotency key/outbox.",
		citation: "Sol audit Q-13; Kleppmann, DDIA ch. 11",
	},
	{
		// SEC-8: test vectors don't establish constant-time behavior.
		id: "in_house_crypto",
		patterns: [
			/\b(?:implement|implementing|build|building|write|writing|roll|rolling)\b.{0,60}\b(?:argon2|chacha|poly1305|aes|ed25519|curve25519|sha-?3|hmac|signature scheme|cipher)/i,
		],
		unless: /audited|vetted|libsodium|ring\b|openssl|boringssl|wrap|binding/i,
		rationale:
			"Implementing cryptographic primitives in-house: test vectors prove correctness on the vectors, not constant-time behavior or side-channel safety. Prefer audited implementations, or commit to a dedicated review + constant-time verification program.",
		citation: "Sol audit SEC-8",
	},
	{
		// D-4: rustc's forbid level cannot be lowered by an inner allow.
		id: "rust_forbid_allow_conflict",
		patterns: [/forbid\(unsafe_code\)/, /allow\(unsafe_code\)/],
		rationale:
			"#![forbid(unsafe_code)] cannot be overridden by an inner #[allow(unsafe_code)] — forbid is not lowerable. Unsafe islands must live in separate crates whose roots don't inherit the forbid.",
		citation: "Sol audit D-4; rustc lint-levels docs",
	},
	{
		// S-1: equal truncated locators do not prove equal contents.
		id: "truncated_hash_identity",
		patterns: [/truncat\w*.{0,40}\b(?:hash|digest)|\b(?:hash|digest)\b.{0,40}truncat\w*/i, /\b(?:identity|identical|equality|≡|unique|content-addressed)\b/i],
		unless: /collision (?:resolution|handling|check)|full digest/i,
		rationale:
			"A truncated hash as identity: equal locators no longer prove equal contents. Store the full digest and treat the truncation as an index key with collision resolution.",
		citation: "Sol audit S-1",
	},
	{
		// P0-10: filtering results post-hoc is not visibility/authz.
		id: "post_filter_visibility",
		patterns: [
			/\bfilter(?:ing|ed)?\b.{0,50}\b(?:results|output|invisible|unauthorized|deleted)\b|\b(?:results|output)\b.{0,30}\bfilter(?:ing|ed)?\b/i,
			/\b(?:snapshot|visibility|authoriz|permission|MVCC|historical)/i,
		],
		unless: /traversal|routing|before expansion|index generation|candidate generation/i,
		rationale:
			"Filtering invisible/unauthorized items from OUTPUT is insufficient when they can still influence traversal, routing, statistics, or timing. Visibility must bind the search structure itself (snapshot/capability-legal traversal), not just the result set.",
		citation: "Sol audit P0-10/P0-11",
	},
	{
		// V-2: validating a system with its own implementation is common-mode.
		id: "self_oracle_validation",
		patterns: [
			/\b(?:validate|verify|check)\w*\b.{0,60}\b(?:its own|our own|the same|itself)\b|\bown\b.{0,30}\b(?:detector|checker|oracle|implementation)\b/i,
			/\b(?:oracle|reference|correctness|serialization|conformance)/i,
		],
		unless: /independent|separate|deliberately (?:different|distinct)|second implementation/i,
		rationale:
			"Using the system's own implementation to validate its own outputs is a common-mode failure — one bug satisfies both sides. The oracle must be an independently written (deliberately simpler) implementation.",
		citation: "Sol audit V-2",
	},
	{
		// Q-10: pairwise/Kahan reduction doesn't give cross-machine identity.
		id: "float_byte_identity",
		patterns: [
			/byte[- ]identical|bit[- ]for[- ]bit|bitwise[- ]identical/i,
			/\b(?:float|floating|f32|f64|double|aggregat|reduc|sum)/i,
		],
		unless: /same (?:target|build|machine|binary)|numeric profile|scoped to identical/i,
		rationale:
			"Byte-identical floating-point results across heterogeneous machines need more than a deterministic reduction order: SIMD width, FMA contraction, denormals, NaN payloads, and libm differ per target. Define a strict portable numeric profile or scope the claim to identical builds.",
		citation: "Sol audit Q-10; Rust f64 platform-dependence docs",
	},
];

/** Max findings per file. */
const MAX_MATCHES = 10;

/** One pitfall entry against one line. */
function pitfallFires(entry: PitfallEntry, line: string): boolean {
	if (entry.unless?.test(line)) return false;
	return entry.patterns.every((p) => p.test(line));
}

/**
 * Known spec pitfalls: claim shapes that audits refute over and over.
 * Markdown-only, line-scoped (all patterns must co-occur on one line — the
 * FP control), advisory always.
 */
export function checkSpecPitfalls(content: string, filePath: string): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	// Skip fenced code and blockquotes (round-2 #26): a fenced example or a
	// quoted critique that NAMES a pitfall is illustration, not a claim.
	const fenced = fencedLineSet(extractFencedBlocks(lines));
	for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
		const line = lines[i] ?? "";
		if (line.length < 20 || fenced.has(i + 1) || line.trimStart().startsWith(">")) {
			continue;
		}
		for (const entry of PITFALLS) {
			if (!pitfallFires(entry, line)) continue;
			out.push({
				line: i + 1,
				text: siteText(`[${entry.id}] ${entry.rationale} (${entry.citation})`),
			});
			break; // one finding per line — the strongest entry wins
		}
	}
	return out;
}

/** Guarantee-verb sentences lacking a [claim: …] tag — the audit's own
 *  "claim taxonomy" remedy as a nudge. Scoped by the registry entry to
 *  enrolled spec docs via content keywords; advisory always. */
export function checkSpecClaimUntagged(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	// Reuse the single claim-sentence extractor (round-2 #27): it already
	// knows the verb set, the [claim: …] tag grammar, and fence-exclusion, so
	// this nudge can't drift from it.
	const specLines = content.split("\n");
	const claims = extractClaimSentences(
		specLines,
		fencedLineSet(extractFencedBlocks(specLines)),
	);
	// Only docs that have OPTED IN (at least one tagged claim) get nudged about
	// the rest — adoption stays voluntary per file (no repo-wide nag).
	if (!claims.some((c) => c.tagged)) return [];
	const out: InlineMatch[] = [];
	for (const claim of claims) {
		if (out.length >= MAX_MATCHES) break;
		if (claim.tagged) continue;
		out.push({
			line: claim.line,
			text: siteText(
				`untagged guarantee claim ("${claim.verb}") — this file uses [claim: …] tags; classify this one (theorem | model | runtime | statistical | benchmark) so reviewers know what evidence backs it`,
			),
		});
	}
	return out;
}
