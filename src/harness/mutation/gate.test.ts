import { describe, expect, it } from "vitest";
import {
	type FileOverlay,
	type MutationGateContext,
	type MutationRunner,
	type PerEditMutationConfig,
	runPerEditMutationGate,
} from "./gate.js";
import { emptyManifest } from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutationManifest, MutationReceipt, TestRunResult } from "./types.js";

const FILE = "src/x.ts";
const CONTENT = "function bar(x: number): boolean { return x > 0; }\n";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};

function cfg(over: Partial<PerEditMutationConfig> = {}): PerEditMutationConfig {
	return { enabled: true, mode: "block", unavailable_behavior: "allow_unmeasured", ...over };
}

function survivor(status: AdaptedMutant["status"] = "survived"): AdaptedMutant {
	return {
		raw: { file: FILE, mutator: "Eq", originalLexeme: ">", replacement: ">=", startOffset: CONTENT.indexOf("> 0") },
		status,
	};
}

function fakeRunner(mutants: AdaptedMutant[], avail = true, testRun?: TestRunResult): MutationRunner {
	return { available: () => avail, run: () => Promise.resolve(testRun ? { mutants, testRun } : { mutants }) };
}

function ctx(over: Partial<MutationGateContext> = {}): MutationGateContext {
	return {
		toolName: "Write",
		toolInput: { file_path: FILE, content: CONTENT },
		config: cfg(),
		runner: fakeRunner([survivor()]),
		baseManifest: emptyManifest(META),
		readDisk: () => CONTENT,
		at: "t",
		...over,
	};
}

describe("runPerEditMutationGate", () => {
	it("no-ops when disabled", async () => {
		expect(await runPerEditMutationGate(ctx({ config: cfg({ enabled: false }) }))).toBeNull();
	});

	it("no-ops when mode is off", async () => {
		expect(await runPerEditMutationGate(ctx({ config: cfg({ mode: "off" }) }))).toBeNull();
	});

	it("no-ops for a non-mutating tool", async () => {
		expect(await runPerEditMutationGate(ctx({ toolName: "Read" }))).toBeNull();
	});

	it("no-ops when no code file is touched", async () => {
		expect(await runPerEditMutationGate(ctx({ toolInput: { file_path: "README.md", content: "x" } }))).toBeNull();
	});

	it("returns a not-measured allow when no runner is configured", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.[0]).toContain("[mutation:not-measured]");
	});

	it("returns not-measured when the runner reports unavailable", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([], false) }));
		expect(d?.warnings?.[0]).toContain("not-measured");
	});

	it("fails closed when unavailable_behavior is block", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: null, config: cfg({ unavailable_behavior: "block" }) }));
		expect(d?.decision).toBe("block");
	});

	it("blocks a measured new survivor", async () => {
		const d = await runPerEditMutationGate(ctx());
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("surviving mutant");
	});

	it("downgrades a block to a warning when mode is warn", async () => {
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.length).toBeGreaterThan(0);
	});

	it("allows a measured clean run (killed)", async () => {
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]) }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings).toBeUndefined();
	});

	it("blocks a red overlay suite through the gate, even with a killed mutant (spec §7)", async () => {
		const runner = fakeRunner([survivor("killed")], true, { overlayGreen: false, redWitnessSatisfied: null });
		const d = await runPerEditMutationGate(ctx({ runner }));
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("RED on this edit");
	});

	it("no-ops when the edited file has no disk content to overlay", async () => {
		const d = await runPerEditMutationGate(ctx({ readDisk: () => null }));
		expect(d).toBeNull();
	});

	it("returns not-measured when the runner throws", async () => {
		const throwing: MutationRunner = { available: () => true, run: () => Promise.reject(new Error("boom")) };
		const d = await runPerEditMutationGate(ctx({ runner: throwing }));
		expect(d?.warnings?.[0]).toContain("not-measured");
	});

	it("ships the full overlay set: primary first, companion test read from disk (spec §7)", async () => {
		let captured: FileOverlay[] | undefined;
		const capturing: MutationRunner = {
			available: () => true,
			run: (_f, _o, overlays) => {
				captured = overlays;
				return Promise.resolve({ mutants: [survivor("killed")] });
			},
		};
		// ctx's readDisk returns content for every path — so the companion test
		// "exists" on local disk and must travel with the edit.
		await runPerEditMutationGate(ctx({ runner: capturing }));
		expect(captured?.map((o) => o.path)).toEqual([FILE, "src/x.test.ts"]);
		expect(captured?.[0]?.content).toBe(CONTENT);
	});
});

describe("runPerEditMutationGate — manifest/receipt persistence (spec §4/§12)", () => {
	function persistSpy(): { calls: Array<{ generation: number; overlayHash: string }>; persist: (m: MutationManifest, r: MutationReceipt) => void } {
		const calls: Array<{ generation: number; overlayHash: string }> = [];
		return { calls, persist: (m, r) => calls.push({ generation: m.generation, overlayHash: r.overlayHash }) };
	}

	it("persists the refreshed manifest + receipt on a measured-clean allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.generation).toBe(1); // bumped from the empty manifest's 0
		expect(spy.calls[0]?.overlayHash).toHaveLength(64); // receipt bound to the overlay
	});

	it("does NOT persist on a survivor block", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ persist: spy.persist }));
		expect(d?.decision).toBe("block");
		expect(spy.calls).toHaveLength(0);
	});

	it("does NOT persist when warn-mode downgrades a dirty run to allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ config: cfg({ mode: "warn" }), persist: spy.persist }));
		expect(d?.decision).toBe("allow"); // downgraded on the wire…
		expect(spy.calls).toHaveLength(0); // …but the OUTCOME was dirty → no refresh
	});

	it("does NOT persist on a not-measured allow", async () => {
		const spy = persistSpy();
		const d = await runPerEditMutationGate(ctx({ runner: null, persist: spy.persist }));
		expect(d?.decision).toBe("allow");
		expect(spy.calls).toHaveLength(0);
	});

	it("surfaces a persistence failure as a warning — the allow stands", async () => {
		const persist = () => {
			throw new Error("disk full");
		};
		const d = await runPerEditMutationGate(ctx({ runner: fakeRunner([survivor("killed")]), persist }));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.some((w) => w.includes("persistence failed") && w.includes("disk full"))).toBe(true);
	});
});
