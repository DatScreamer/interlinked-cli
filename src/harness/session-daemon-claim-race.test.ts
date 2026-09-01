import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ChildClaimResult {
	pid: number;
	claim: { claimed: true } | { claimed: false; ownerPid: number };
}

interface StartedClaimer {
	ready: Promise<void>;
	result: Promise<ChildClaimResult>;
}

let temp = "";

afterEach(() => {
	if (temp !== "") rmSync(temp, { recursive: true, force: true });
	temp = "";
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseChildClaimResult(raw: string): ChildClaimResult {
	const value: unknown = JSON.parse(raw);
	if (!isRecord(value)) {
		throw new Error("claim child result is not an object");
	}
	const claim = value.claim;
	if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || !isRecord(claim)) {
		throw new Error("claim child result is missing pid/claim");
	}
	if (claim.claimed === true) return { pid: value.pid, claim: { claimed: true } };
	const ownerPid = claim.ownerPid;
	if (claim.claimed !== false || typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid)) {
		throw new Error("claim child result has an invalid loser shape");
	}
	return { pid: value.pid, claim: { claimed: false, ownerPid } };
}

function startClaimer(pidPath: string, goPath: string): StartedClaimer {
	const moduleUrl = new URL("./session-daemon.ts", import.meta.url).href;
	const source = `
		import { existsSync } from "node:fs";
		import { claimSessionPid } from ${JSON.stringify(moduleUrl)};
		const wait = new Int32Array(new SharedArrayBuffer(4));
		process.stdout.write("READY\\n");
		while (!existsSync(${JSON.stringify(goPath)})) Atomics.wait(wait, 0, 0, 1);
		const claim = claimSessionPid(${JSON.stringify(pidPath)}, process.pid);
		process.stdout.write(JSON.stringify({ pid: process.pid, claim }) + "\\n");
		if (claim.claimed) Atomics.wait(wait, 0, 0, 250);
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let readyResolved = false;
	let resolveReady: () => void = () => undefined;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
		if (!readyResolved && stdout.includes("READY\n")) {
			readyResolved = true;
			resolveReady();
		}
	});
	const result = new Promise<ChildClaimResult>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) {
				reject(new Error(`claim child exited ${String(code)}: ${child.stderr.read()?.toString() ?? ""}`));
				return;
			}
			const row = stdout
				.trim()
				.split("\n")
				.find((line) => line.startsWith("{"));
			if (!row) {
				reject(new Error(`claim child emitted no result: ${stdout}`));
				return;
			}
			resolve(parseChildClaimResult(row));
		});
	});
	return { ready, result };
}

async function raceClaimers(pidPath: string): Promise<[ChildClaimResult, ChildClaimResult]> {
	const goPath = `${pidPath}.go`;
	const first = startClaimer(pidPath, goPath);
	const second = startClaimer(pidPath, goPath);
	await Promise.all([first.ready, second.ready]);
	writeFileSync(goPath, "go", { flag: "wx" });
	return Promise.all([first.result, second.result]);
}

describe("claimSessionPid — real process races", () => {
	it("allows exactly one of two simultaneous claimers to win", async () => {
		temp = mkdtempSync(join(tmpdir(), "interlinked-session-claim-"));
		const pidPath = join(temp, "session.pid");
		const results = await raceClaimers(pidPath);
		const winners = results.filter((row) => row.claim.claimed);
		const losers = results.filter((row) => !row.claim.claimed);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		const winner = winners[0];
		const loser = losers[0];
		expect(winner).toBeDefined();
		expect(loser?.claim).toEqual({ claimed: false, ownerPid: winner?.pid });
		expect(readFileSync(pidPath, "utf8")).toBe(String(winner?.pid));
		expect(existsSync(`${pidPath}.claim`)).toBe(false);
	});

	it("reclaims a stale PID exclusively under simultaneous starts", async () => {
		temp = mkdtempSync(join(tmpdir(), "interlinked-session-stale-"));
		const pidPath = join(temp, "session.pid");
		writeFileSync(pidPath, "2147480000");
		const results = await raceClaimers(pidPath);
		expect(results.filter((row) => row.claim.claimed)).toHaveLength(1);
		expect(results.filter((row) => !row.claim.claimed)).toHaveLength(1);
		const winner = results.find((row) => row.claim.claimed);
		expect(readFileSync(pidPath, "utf8")).toBe(String(winner?.pid));
		expect(existsSync(`${pidPath}.claim`)).toBe(false);
	});
});
