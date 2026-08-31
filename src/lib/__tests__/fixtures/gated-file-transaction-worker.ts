import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	captureGatedWriteBaseline,
	commitGatedWrites,
	GatedWriteConflictError,
} from "../../gated-file-transaction.js";

const root = process.argv[2];
const actor = process.argv[3];
const delayText = process.argv[4];
if (root === undefined || actor === undefined || delayText === undefined) {
	throw new Error("usage: worker <root> <actor> <delay-ms>");
}
const delayMs = Number(delayText);
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`invalid delay: ${delayText}`);

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const transaction = captureGatedWriteBaseline(root, [
	{ path: "target.txt", content: actor },
]);
writeFileSync(join(root, `ready-${actor}`), "ready");
while (!existsSync(join(root, "go"))) await wait(5);
await wait(delayMs);

try {
	commitGatedWrites(transaction);
	process.stdout.write(`${JSON.stringify({ actor, status: "ok" })}\n`);
} catch (error) {
	const status = error instanceof GatedWriteConflictError ? "conflict" : "error";
	process.stdout.write(
		`${JSON.stringify({
			actor,
			status,
			message: error instanceof Error ? error.message : String(error),
		})}\n`,
	);
}
