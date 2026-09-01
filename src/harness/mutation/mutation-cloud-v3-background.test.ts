import { describe, expect, it, vi } from "vitest";
import type { MutationCloudV3ProcessResult } from "./mutation-cloud-v3-runtime.js";
import type { MutationFindingDeliveryOutcome } from "./mutation-cloud-v3-finding-delivery.js";
import { startMutationCloudV3Background } from "./mutation-cloud-v3-background.js";

const IDLE: MutationCloudV3ProcessResult = {
	processor: { kind: "idle" },
	evaluation: null,
};

function dependencies(overrides: {
	exists?: boolean;
	backgroundEnabled?: boolean;
	processNext?: () => Promise<MutationCloudV3ProcessResult>;
	deliverOneFinding?: () => Promise<MutationFindingDeliveryOutcome>;
} = {}) {
	const close = vi.fn();
	const processNext = vi.fn(overrides.processNext ?? (async () => IDLE));
	const deliverOneFinding = vi.fn(overrides.deliverOneFinding ?? (async () => ({ kind: "idle" as const })));
	const openRuntime = vi.fn(() => ({ processNext, deliverOneFinding, close }));
	return {
		close,
		processNext,
		deliverOneFinding,
		openRuntime,
		configExists: vi.fn(() => overrides.exists ?? true),
		loadConfig: vi.fn(() => ({ backgroundEnabled: overrides.backgroundEnabled ?? true }) as never),
	};
}

describe("mutation cloud v3 background scheduler", () => {
	it("stays silent and never opens a runtime when the opt-in file is absent", async () => {
		const deps = dependencies({ exists: false });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("disabled");
		expect(deps.openRuntime).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		background.stop();
	});

	it("keeps an enabled manual config autonomous-off without the separate background opt-in", async () => {
		const deps = dependencies({ backgroundEnabled: false });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("disabled");
		expect(deps.loadConfig).toHaveBeenCalledTimes(1);
		expect(deps.openRuntime).not.toHaveBeenCalled();
		expect(deps.processNext).not.toHaveBeenCalled();
		expect(deps.deliverOneFinding).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
		background.stop();
	});

	it("processes one due job through the shared runtime and always closes it", async () => {
		const acknowledged: MutationCloudV3ProcessResult = {
			processor: { kind: "acknowledged", jobId: "job-1", phase: "poll" },
			evaluation: null,
		};
		const deps = dependencies({ processNext: async () => acknowledged });
		const onResult = vi.fn();
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, onResult, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(deps.processNext).toHaveBeenCalledTimes(1);
		expect(deps.deliverOneFinding).toHaveBeenCalledTimes(1);
		expect(deps.close).toHaveBeenCalledTimes(1);
		expect(onResult).toHaveBeenCalledWith(acknowledged);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("journaled and acknowledged"));
		background.stop();
	});

	it("delivers a committed finding even when remote result processing fails", async () => {
		const delivered = {
			kind: "delivered" as const,
			outboxId: `1:${"a".repeat(64)}`,
			message: "[interlinked:mutation] adverse result",
		};
		const deps = dependencies({
			processNext: async () => {
				throw new Error("remote unavailable");
			},
			deliverOneFinding: async () => delivered,
		});
		const onFinding = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), onFinding, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("failed");
		expect(onFinding).toHaveBeenCalledWith(delivered);
		expect(deps.deliverOneFinding).toHaveBeenCalledTimes(1);
		expect(deps.close).toHaveBeenCalledTimes(1);
		background.stop();
	});

	it("counts finding-only delivery as processed and surfaces it through the callback", async () => {
		const delivered = {
			kind: "delivered" as const,
			outboxId: `1:${"b".repeat(64)}`,
			message: "[interlinked:mutation] baseline adopted",
		};
		const deps = dependencies({ deliverOneFinding: async () => delivered });
		const onFinding = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), onFinding, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("processed");
		expect(onFinding).toHaveBeenCalledWith(delivered);
		background.stop();
	});

	it("does not overlap slow ticks and resumes after the first tick settles", async () => {
		let settle: ((value: MutationCloudV3ProcessResult) => void) | undefined;
		let calls = 0;
		const deps = dependencies({
			processNext: () => {
				calls += 1;
				if (calls > 1) return Promise.resolve(IDLE);
				return new Promise((resolve) => {
					settle = resolve;
				});
			},
		});
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), intervalMs: 60_000 },
			deps,
		);

		const first = background.tick();
		await vi.waitFor(() => expect(deps.processNext).toHaveBeenCalledTimes(1));
		expect(await background.tick()).toBe("busy");
		settle?.(IDLE);
		expect(await first).toBe("idle");
		await vi.waitFor(() => expect(deps.close).toHaveBeenCalledTimes(1));
		expect(await background.tick()).toBe("idle");
		expect(deps.processNext).toHaveBeenCalledTimes(2);
		background.stop();
	});

	it("deduplicates repeated failures without suppressing a later distinct failure", async () => {
		const deps = dependencies();
		deps.loadConfig
			.mockImplementationOnce(() => { throw new Error("bad config"); })
			.mockImplementationOnce(() => { throw new Error("bad config"); })
			.mockImplementationOnce(() => { throw new Error("network unavailable"); });
		const log = vi.fn();
		const background = startMutationCloudV3Background(
			{ root: "/repo", log, intervalMs: 60_000 },
			deps,
		);

		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledTimes(1);
		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledTimes(1);
		expect(await background.tick()).toBe("failed");
		expect(log).toHaveBeenCalledTimes(2);
		background.stop();
	});

	it("stops future work and rejects sub-second polling intervals", async () => {
		const deps = dependencies({ exists: false });
		const background = startMutationCloudV3Background(
			{ root: "/repo", log: vi.fn(), intervalMs: 1_000 },
			deps,
		);
		background.stop();
		expect(await background.tick()).toBe("disabled");
		expect(() => startMutationCloudV3Background({
			root: "/repo",
			log: vi.fn(),
			intervalMs: 999,
		}, deps)).toThrow("at least 1000ms");
	});
});
