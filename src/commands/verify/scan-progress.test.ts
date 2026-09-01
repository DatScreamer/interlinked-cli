// Tests for the stderr-only scan progress reporter.
//
// The defect this module fixes: `interlinked verify --all-checks` emitted
// nothing for 6m20s on a 3000-file tree. The reporter must therefore prove
// three things — it writes DURING the span (not after), it writes only to the
// injected sink (never stdout), and it names the slowest files afterwards.

import { describe, expect, it, vi } from "vitest";

import {
	createScanProgress,
	formatSeconds,
	formatSlowestFiles,
	YIELD_EVERY_FILES,
	yieldToEventLoop,
} from "./scan-progress.js";

/** Collect writes plus the wall position (files done) at write time. */
function makeSink(): { chunks: string[]; write: (chunk: string) => void } {
	const chunks: string[] = [];
	return { chunks, write: (chunk: string) => void chunks.push(chunk) };
}

/** Deterministic clock: each read advances by `stepMs`. */
function makeClock(stepMs: number): () => number {
	let t = 0;
	return () => {
		const at = t;
		t += stepMs;
		return at;
	};
}

describe("createScanProgress — writes during the span (must fire)", () => {
	it("P1: renders an initial line on start() before any file completes", () => {
		const sink = makeSink();
		const p = createScanProgress(4, { write: sink.write, now: makeClock(0) });
		p.start("checks");
		expect(sink.chunks).toHaveLength(1);
		expect(sink.chunks[0]).toContain("scanning checks 0/4");
	});

	it("P2: emits an intermediate count while files still remain", () => {
		const sink = makeSink();
		const p = createScanProgress(4, { write: sink.write, now: makeClock(1000), intervalMs: 500 });
		p.start("checks");
		p.advance("/repo/a.ts", 10);
		// A line naming 1/4 can only have been written with 3 files left to go.
		expect(sink.chunks.join("")).toContain("scanning checks 1/4");
	});

	it("P3: repaints in place using the carriage-return clear sequence", () => {
		const sink = makeSink();
		const p = createScanProgress(2, { write: sink.write, now: makeClock(1000) });
		p.start("exports");
		p.advance("/repo/a.ts", 1);
		expect(sink.chunks.every((c) => c.startsWith("\r\x1b[K"))).toBe(true);
	});

	it("P4: names the current file on the line", () => {
		const sink = makeSink();
		const p = createScanProgress(1, { write: sink.write, now: makeClock(1000) });
		p.start("checks");
		p.advance("/repo/src/thing.ts", 5);
		expect(sink.chunks.join("")).toContain("/repo/src/thing.ts");
	});

	it("P5: truncates a long path to its tail rather than wrapping the line", () => {
		const sink = makeSink();
		const long = `/repo/${"deep/".repeat(30)}file.ts`;
		const p = createScanProgress(1, { write: sink.write, now: makeClock(1000) });
		p.start("checks");
		p.advance(long, 5);
		const line = sink.chunks.join("");
		expect(line).toContain("…");
		expect(line).not.toContain("/repo/deep/deep/deep");
	});

	it("P6: always repaints on the final file even inside the throttle window", () => {
		const sink = makeSink();
		// Clock never advances => every advance is inside the throttle window.
		const p = createScanProgress(2, { write: sink.write, now: () => 0, intervalMs: 500 });
		p.start("checks");
		p.advance("/a.ts", 1);
		p.advance("/b.ts", 1);
		expect(sink.chunks.join("")).toContain("scanning checks 2/2");
	});

	it("P7: reports elapsed seconds from the phase start", () => {
		const sink = makeSink();
		const p = createScanProgress(1, { write: sink.write, now: makeClock(1500) });
		p.start("checks");
		p.advance("/a.ts", 1);
		// start() reads t=0, render reads t=1500, advance reads t=3000,
		// its render reads t=4500 => 4.5s since phase start.
		expect(sink.chunks.join("")).toContain("4.5s");
	});
});

describe("createScanProgress — throttling and silence (must not fire)", () => {
	it("N1: does not repaint twice inside one interval when files remain", () => {
		const sink = makeSink();
		const p = createScanProgress(10, { write: sink.write, now: () => 0, intervalMs: 500 });
		p.start("checks");
		p.advance("/a.ts", 1);
		p.advance("/b.ts", 1);
		p.advance("/c.ts", 1);
		// Only the start() render survives the throttle.
		expect(sink.chunks).toHaveLength(1);
	});

	it("N2: writes nothing at all before start() is called", () => {
		const sink = makeSink();
		createScanProgress(10, { write: sink.write, now: () => 0 });
		expect(sink.chunks).toHaveLength(0);
	});

	it("N3: does not read the clock at construction time", () => {
		const now = vi.fn(() => 0);
		createScanProgress(10, { write: () => {}, now });
		expect(now).not.toHaveBeenCalled();
	});

	it("N4: finish() clears the line and adds no trailing text", () => {
		const sink = makeSink();
		const p = createScanProgress(1, { write: sink.write, now: () => 0 });
		p.start("checks");
		sink.chunks.length = 0;
		p.finish();
		expect(sink.chunks).toEqual(["\r\x1b[K"]);
	});
});

describe("createScanProgress — slowest-file accumulator", () => {
	it("P1: ranks files by descending elapsed time", () => {
		const p = createScanProgress(3, { write: () => {}, now: () => 0 });
		p.start("checks");
		p.advance("/fast.ts", 5);
		p.advance("/slow.ts", 900);
		p.advance("/mid.ts", 100);
		expect(p.slowest().map((s) => s.file)).toEqual(["/slow.ts", "/mid.ts", "/fast.ts"]);
	});

	it("P2: honours an explicit limit", () => {
		const p = createScanProgress(3, { write: () => {}, now: () => 0 });
		p.start("checks");
		p.advance("/a.ts", 30);
		p.advance("/b.ts", 20);
		p.advance("/c.ts", 10);
		expect(p.slowest(1)).toEqual([{ file: "/a.ts", ms: 30 }]);
	});

	it("N1: drops zero-cost files so the list names real cost only", () => {
		const p = createScanProgress(2, { write: () => {}, now: () => 0 });
		p.start("checks");
		p.advance("/free.ts", 0);
		expect(p.slowest()).toEqual([]);
	});

	it("N2: keeps memory bounded across a large file count", () => {
		const p = createScanProgress(500, { write: () => {}, now: () => 0 });
		p.start("checks");
		for (let i = 0; i < 500; i++) p.advance(`/f${i}.ts`, i + 1);
		expect(p.slowest(1000)).toHaveLength(10);
		expect(p.slowest(1)[0]?.file).toBe("/f499.ts");
	});
});

describe("formatSlowestFiles", () => {
	it("P1: names the slow files once the run crosses the reporting threshold", () => {
		const line = formatSlowestFiles([{ file: "/repo/a.ts", ms: 2500 }], 9000);
		expect(line).toContain("slowest files");
		expect(line).toContain("/repo/a.ts 2.5s");
		expect(line?.endsWith("\n")).toBe(true);
	});

	it("N1: stays silent for a fast run", () => {
		expect(formatSlowestFiles([{ file: "/repo/a.ts", ms: 10 }], 100)).toBeNull();
	});

	it("N2: stays silent when nothing was timed", () => {
		expect(formatSlowestFiles([], 60_000)).toBeNull();
	});
});

describe("formatSeconds", () => {
	it("P1: renders milliseconds as one-decimal seconds", () => {
		expect(formatSeconds(1500)).toBe("1.5");
	});

	it("P2: renders sub-second durations without rounding to a whole", () => {
		expect(formatSeconds(100)).toBe("0.1");
	});
});

describe("yieldToEventLoop", () => {
	it("P1: resolves after letting a queued macrotask run", async () => {
		const order: string[] = [];
		setImmediate(() => order.push("queued"));
		await yieldToEventLoop();
		expect(order).toEqual(["queued"]);
	});

	it("P2: exposes a yield cadence small enough to keep Ctrl-C responsive", () => {
		expect(YIELD_EVERY_FILES).toBeGreaterThan(0);
		expect(YIELD_EVERY_FILES).toBeLessThanOrEqual(100);
	});
});
