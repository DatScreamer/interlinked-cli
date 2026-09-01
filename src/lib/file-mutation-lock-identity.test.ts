import { describe, expect, it } from "vitest";
import { readFileMutationProcessIdentity } from "./file-mutation-lock-identity.js";

describe("file-mutation lock process identity", () => {
	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"reads stable boot and process-start identity on supported platforms",
		() => {
			const first = readFileMutationProcessIdentity(process.pid, 10_000);
			const second = readFileMutationProcessIdentity(process.pid, 20_000);
			expect(first).toBe(second);
			expect(first.bootId).toMatch(new RegExp(`^${process.platform}:`));
			expect(first.processStartId).toMatch(new RegExp(`^${process.platform}:`));
			expect(first.bootStartedAtMs).toBeGreaterThan(0);
		},
	);

	it("fails conservatively when a foreign PID cannot be observed", () => {
		const identity = readFileMutationProcessIdentity(2_147_483_647, 30_000);
		expect(identity.processStartId).toBeNull();
		expect(identity.processStartedAtMs).toBeNull();
	});

	it.runIf(process.platform === "darwin" || process.platform === "linux")(
		"derives an epoch for rolling-upgrade PID reuse checks",
		() => {
			const identity = readFileMutationProcessIdentity(process.pid, 40_000);
			expect(identity.processStartedAtMs).toBeGreaterThan(0);
		},
	);
});
