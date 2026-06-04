// Determinism-replay driver — proof-of-enforcement §15 step 0 (fresh-process rung).
//
// @determinism-critical — emits the canonical findings other processes compare
// against; must itself stay free of locale-/FS-order-/wall-clock-dependent idioms.
//
// A thin filter: reads a corpus (JSON `[{ path, content }]`) on stdin, runs the
// inline pipeline on each item, and writes the canonical findings (JSON
// `string[]`, one canonical blob per item) to stdout. The conformance test runs
// this in a FRESH process — under a perturbed timezone/locale — and compares its
// output byte-for-byte against an in-process run, surfacing nondeterminism
// seeded at process start (import-time constants, environment, timezone) that a
// same-process repeat cannot. This same driver is the cloud-Sandbox rung's entry
// point (run it there, diff against local — the real cross-machine test).

import { type CorpusItem, canonicalizeFindings, runInlinePipeline } from "./determinism-conformance.js";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
	const corpus = JSON.parse(await readStdin()) as CorpusItem[];
	const canon = corpus.map((item) =>
		canonicalizeFindings(runInlinePipeline(item.content, item.path)),
	);
	process.stdout.write(JSON.stringify(canon));
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
