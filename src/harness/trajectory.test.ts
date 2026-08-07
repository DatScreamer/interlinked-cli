// ===========================================
// Trajectory State Machine — Unit Tests
// ===========================================
//
// Phase D.2: per-session trajectory anti-pattern detection. Validates the
// four pattern detectors (tool_loop, destructive_sequence, unbackedoff_retry,
// silent_stall) end-to-end against a synthetic event stream. Covers positive
// firing, negative non-firing, and boundary timing for each pattern, plus
// ring-buffer eviction and reset semantics.

import { describe, expect, it } from "vitest";
import {
	createTrajectoryDetector,
	type TrajectoryEvent,
	type TrajectoryFinding,
} from "./trajectory.js";

// Stable base timestamp; tests construct deltas explicitly so each scenario
// reads as a literal timeline rather than depending on Date.now().
const T0 = 1_700_000_000_000;

function ev(overrides: Partial<TrajectoryEvent> & { ts_ms: number }): TrajectoryEvent {
	return {
		hook_event: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "echo hi" },
		...overrides,
	};
}

function findings(detector: ReturnType<typeof createTrajectoryDetector>, events: TrajectoryEvent[]): TrajectoryFinding[] {
	let last: TrajectoryFinding[] = [];
	for (const e of events) last = detector.observe(e);
	return last;
}

describe("trajectory.tool_loop", () => {
	it("fires when same Bash command runs 6 times in 60s", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 6; i++) {
			events.push(ev({ ts_ms: T0 + i * 5_000, tool_input: { command: "ls /tmp" } }));
		}
		const result = findings(detector, events);
		const loop = result.find((f) => f.pattern === "tool_loop");
		expect(loop).toBeDefined();
		expect(loop?.severity).toBe("warning");
		expect(loop?.message).toMatch(/looping on Bash/i);
		expect(loop?.evidence.length).toBeGreaterThan(0);
		expect(loop?.evidence.length).toBeLessThanOrEqual(3);
	});

	it("does not fire when 6 calls span > 60s window", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		// Spaced 15s apart → 6th call at +75s, well outside the 60s window for
		// most of the earlier calls.
		for (let i = 0; i < 6; i++) {
			events.push(ev({ ts_ms: T0 + i * 15_000, tool_input: { command: "ls /tmp" } }));
		}
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "tool_loop")).toBeUndefined();
	});

	it("does not fire when each call has different inputs", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 6; i++) {
			events.push(ev({ ts_ms: T0 + i * 5_000, tool_input: { command: `ls /tmp/${i}` } }));
		}
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "tool_loop")).toBeUndefined();
	});

	it("boundary: exactly 5 identical calls in window does NOT fire (threshold is >5)", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 5; i++) {
			events.push(ev({ ts_ms: T0 + i * 5_000, tool_input: { command: "ls /tmp" } }));
		}
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "tool_loop")).toBeUndefined();
	});

	it("evidence uses file_path when the event carries no command", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 6; i++) {
			events.push(
				ev({
					ts_ms: T0 + i * 5_000,
					tool_name: "Read",
					tool_input: { file_path: "/a.ts" },
				}),
			);
		}
		const result = findings(detector, events);
		const loop = result.find((f) => f.pattern === "tool_loop");
		expect(loop).toBeDefined();
		expect(loop?.evidence.some((e) => e.includes("/a.ts"))).toBe(true);
	});

	it("evidence falls back to bare tool_name when neither command nor file_path is present", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 6; i++) {
			events.push(ev({ ts_ms: T0 + i * 5_000, tool_name: "Glob", tool_input: {} }));
		}
		const result = findings(detector, events);
		const loop = result.find((f) => f.pattern === "tool_loop");
		expect(loop).toBeDefined();
		expect(loop?.evidence.some((e) => e === '"Glob"')).toBe(true);
	});

	it("suppresses a repeat tool_loop fire for the same pattern within the cooldown window", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 7; i++) {
			events.push(ev({ ts_ms: T0 + i * 5_000, tool_input: { command: "ls /tmp" } }));
		}
		const perCallResults = events.map((e) => detector.observe(e));
		expect(perCallResults[5]?.find((f) => f.pattern === "tool_loop")).toBeDefined();
		expect(perCallResults[6]?.find((f) => f.pattern === "tool_loop")).toBeUndefined();
	});

	it("does not fire when an Edit (state change) occurs between Read calls", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) {
			events.push(
				ev({
					ts_ms: T0 + i * 5_000,
					tool_name: "Read",
					tool_input: { file_path: "/a.ts" },
				}),
			);
		}
		// Observable state change: an Edit happened in between (Pre + Post pair).
		events.push(
			ev({
				ts_ms: T0 + 16_000,
				tool_name: "Edit",
				tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
			}),
		);
		events.push(
			ev({
				ts_ms: T0 + 16_500,
				hook_event: "PostToolUse",
				tool_name: "Edit",
				tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
				succeeded: true,
			}),
		);
		for (let i = 0; i < 3; i++) {
			events.push(
				ev({
					ts_ms: T0 + 17_000 + i * 5_000,
					tool_name: "Read",
					tool_input: { file_path: "/a.ts" },
				}),
			);
		}
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "tool_loop")).toBeUndefined();
	});
});

describe("trajectory.destructive_sequence", () => {
	it("fires on rm → mkdir → rm of the same path within 30s", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		];
		const result = findings(detector, events);
		const cycle = result.find((f) => f.pattern === "destructive_sequence");
		expect(cycle).toBeDefined();
		expect(cycle?.message).toMatch(/destructive cycle on/i);
		expect(cycle?.message).toMatch(/build/);
	});

	it("fires on rm → touch → rm of the same file", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "rm -f /tmp/x.log" } }),
			ev({ ts_ms: T0 + 1_000, tool_input: { command: "touch /tmp/x.log" } }),
			ev({ ts_ms: T0 + 2_000, tool_input: { command: "rm -f /tmp/x.log" } }),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeDefined();
	});

	it("does not fire when the recreate happens > 30s after the first rm", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf cache" } }),
			ev({ ts_ms: T0 + 31_000, tool_input: { command: "mkdir cache" } }),
			ev({ ts_ms: T0 + 32_000, tool_input: { command: "rm -rf cache" } }),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeUndefined();
	});

	it("boundary: detects exactly at the 30s window edge", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 30_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 30_000, tool_input: { command: "rm -rf build" } }),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeDefined();
	});

	it("does not fire on a single rm with no recreate-then-rm pattern", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } })];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeUndefined();
	});

	it("does not fire when the last rm-like event has no tool_input at all", () => {
		const detector = createTrajectoryDetector();
		const result = detector.observe(ev({ ts_ms: T0, tool_input: undefined }));
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeUndefined();
	});

	it("does not fire when the rm command is verb-only with trailing whitespace (no path)", () => {
		const detector = createTrajectoryDetector();
		const result = detector.observe(ev({ ts_ms: T0, tool_input: { command: "rm   " } }));
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeUndefined();
	});

	it("does not fire when the rm command has only flag tokens, no path", () => {
		const detector = createTrajectoryDetector();
		const result = detector.observe(ev({ ts_ms: T0, tool_input: { command: "rm -rf" } }));
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeUndefined();
	});

	it("still fires when a non-Bash call and a command-less Bash call sit between the rm/mkdir/rm cycle", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "rm -rf build" } }),
			ev({ ts_ms: T0 + 3_000, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({ ts_ms: T0 + 4_000, tool_input: {} }),
			ev({ ts_ms: T0 + 5_000, tool_input: { command: "mkdir build" } }),
			ev({ ts_ms: T0 + 10_000, tool_input: { command: "rm -rf build" } }),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "destructive_sequence")).toBeDefined();
	});
});

describe("trajectory.unbackedoff_retry", () => {
	it("fires on 3 consecutive failures of same Bash command with no sleep", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) {
			events.push(
				ev({
					ts_ms: T0 + i * 1_000,
					hook_event: "PostToolUseFailure",
					tool_input: { command: "npm test" },
					succeeded: false,
				}),
			);
		}
		const result = findings(detector, events);
		const retry = result.find((f) => f.pattern === "unbackedoff_retry");
		expect(retry).toBeDefined();
		expect(retry?.message).toMatch(/3 retries without backoff/i);
		expect(retry?.message).toMatch(/npm test/);
	});

	it("does not fire when a sleep occurs between failures", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({
				ts_ms: T0,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({ ts_ms: T0 + 500, tool_input: { command: "sleep 5" } }),
			ev({
				ts_ms: T0 + 6_000,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 7_000,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "unbackedoff_retry")).toBeUndefined();
	});

	it("does not fire when failures are interleaved with successes", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({
				ts_ms: T0,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 500,
				hook_event: "PostToolUse",
				tool_input: { command: "npm test" },
				succeeded: true,
			}),
			ev({
				ts_ms: T0 + 1_000,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "unbackedoff_retry")).toBeUndefined();
	});

	it("does not fire when commands differ across failures", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({
				ts_ms: T0,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 100,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm install" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 200,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm build" },
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "unbackedoff_retry")).toBeUndefined();
	});

	it("does not fire when the last failure event is not a Bash tool", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({
				ts_ms: T0,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 100,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 200,
				hook_event: "PostToolUseFailure",
				tool_name: "Read",
				tool_input: { file_path: "/a.ts" },
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "unbackedoff_retry")).toBeUndefined();
	});

	it("does not fire when the last failure has no tool_input (no command)", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({
				ts_ms: T0,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 100,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 200,
				hook_event: "PostToolUseFailure",
				tool_input: undefined,
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "unbackedoff_retry")).toBeUndefined();
	});

	it("still fires when a non-Bash event sits further back in the walk than the retry run", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
			ev({
				ts_ms: T0 + 100,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 200,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 300,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		const retry = result.find((f) => f.pattern === "unbackedoff_retry");
		expect(retry).toBeDefined();
	});

	it("still fires when a command-less Bash event sits further back in the walk", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: {} }),
			ev({
				ts_ms: T0 + 100,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 200,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
			ev({
				ts_ms: T0 + 300,
				hook_event: "PostToolUseFailure",
				tool_input: { command: "npm test" },
				succeeded: false,
			}),
		];
		const result = findings(detector, events);
		const retry = result.find((f) => f.pattern === "unbackedoff_retry");
		expect(retry).toBeDefined();
	});

	it("truncates a long command in the finding message", () => {
		const detector = createTrajectoryDetector();
		const longCmd = `npm test -- ${"x".repeat(100)}`;
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 3; i++) {
			events.push(
				ev({
					ts_ms: T0 + i * 100,
					hook_event: "PostToolUseFailure",
					tool_input: { command: longCmd },
					succeeded: false,
				}),
			);
		}
		const result = findings(detector, events);
		const retry = result.find((f) => f.pattern === "unbackedoff_retry");
		expect(retry).toBeDefined();
		expect(retry?.message).toContain("…");
		expect(retry?.message).not.toContain(longCmd);
	});
});

describe("trajectory.silent_stall", () => {
	it("fires when the latest event is > 10 minutes after the previous event", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 11 * 60_000, tool_input: { command: "ls" } }),
		];
		const result = findings(detector, events);
		const stall = result.find((f) => f.pattern === "silent_stall");
		expect(stall).toBeDefined();
		expect(stall?.message).toMatch(/idle/i);
	});

	it("does not fire when the gap is under 10 minutes", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 9 * 60_000, tool_input: { command: "ls" } }),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "silent_stall")).toBeUndefined();
	});

	it("boundary: exactly 10 minutes does NOT fire (threshold is > 10m)", () => {
		const detector = createTrajectoryDetector();
		const events: TrajectoryEvent[] = [
			ev({ ts_ms: T0, tool_input: { command: "ls" } }),
			ev({ ts_ms: T0 + 10 * 60_000, tool_input: { command: "ls" } }),
		];
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "silent_stall")).toBeUndefined();
	});
});

describe("trajectory ring buffer", () => {
	it("evicts oldest events past the buffer cap so old patterns disappear", () => {
		const detector = createTrajectoryDetector({ bufferSize: 10 });
		// Drown the buffer with 20 different commands (none repeats), then
		// quickly push 6 identical commands inside a 60s window. The ring
		// buffer should hold only the 10 most recent events: 4 of the
		// drowning commands + the 6 identical ones. Tool-loop fires on
		// pure recency, not on drowned-out history.
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 20; i++) {
			events.push(ev({ ts_ms: T0 + i * 100, tool_input: { command: `cmd${i}` } }));
		}
		// Verify drowning history doesn't itself trip a tool_loop.
		const drowningResult = findings(detector, events);
		expect(drowningResult.find((f) => f.pattern === "tool_loop")).toBeUndefined();

		// Now push 6 identical events inside the 60s window.
		const repeats: TrajectoryEvent[] = [];
		for (let i = 0; i < 6; i++) {
			repeats.push(ev({ ts_ms: T0 + 30_000 + i * 1_000, tool_input: { command: "ls /tmp" } }));
		}
		const result = findings(detector, repeats);
		const loop = result.find((f) => f.pattern === "tool_loop");
		expect(loop).toBeDefined();
	});
});

describe("trajectory reset", () => {
	it("clears all internal state so subsequent observe() starts fresh", () => {
		const detector = createTrajectoryDetector();
		// Build up enough history to fire tool_loop.
		const events: TrajectoryEvent[] = [];
		for (let i = 0; i < 6; i++) {
			events.push(ev({ ts_ms: T0 + i * 5_000, tool_input: { command: "ls /tmp" } }));
		}
		const result = findings(detector, events);
		expect(result.find((f) => f.pattern === "tool_loop")).toBeDefined();

		detector.reset();

		// After reset, a single new event should not fire any pattern.
		const next = detector.observe(ev({ ts_ms: T0 + 60_000, tool_input: { command: "ls /tmp" } }));
		expect(next).toEqual([]);
	});
});

describe("trajectory observe() returns empty by default", () => {
	it("first observe returns no findings on a single event", () => {
		const detector = createTrajectoryDetector();
		const result = detector.observe(ev({ ts_ms: T0, tool_input: { command: "ls" } }));
		expect(result).toEqual([]);
	});
});
