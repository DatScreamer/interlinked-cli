import { describe, expect, it } from "vitest";
import {
	collectBaselineAges,
	DEFAULT_STALE_AFTER_DAYS,
	formatStaleBaselineWarning,
	NUDGE_INTERVAL_MS,
	shouldNudge,
	TRACKED_BASELINES,
} from "./baseline-staleness.js";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

/** mtime reader over a {basename: ageInDays} fixture; omitted => file absent. */
function reader(ages: Record<string, number>) {
	return (path: string): number | null => {
		const name = path.split("/").pop() ?? "";
		const days = ages[name];
		return days === undefined ? null : NOW - days * DAY;
	};
}

const fresh = (): Record<string, number> =>
	Object.fromEntries(TRACKED_BASELINES.map((b) => [b.file, 1]));

describe("collectBaselineAges", () => {
	it("reports whole-day ages for present baselines", () => {
		const ages = collectBaselineAges({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader({ ...fresh(), "coverage-baseline.json": 42 }),
		});
		expect(ages.find((a) => a.file === "coverage-baseline.json")?.ageDays).toBe(42);
	});

	it("reports null age for a baseline that was never generated", () => {
		const missing = fresh();
		delete missing["mutation-baseline.json"];
		const ages = collectBaselineAges({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader(missing),
		});
		expect(ages.find((a) => a.file === "mutation-baseline.json")?.ageDays).toBeNull();
	});

	it("covers every tracked baseline", () => {
		const ages = collectBaselineAges({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader(fresh()),
		});
		expect(ages.map((a) => a.file)).toEqual(TRACKED_BASELINES.map((b) => b.file));
	});
});

describe("shouldNudge — keeps the reminder bounded", () => {
	it("nudges when no marker exists (never nudged before)", () => {
		expect(shouldNudge({ interlinkedDir: "/repo/.interlinked", now: NOW, readMtime: () => null })).toBe(
			true,
		);
	});

	it("stays silent when the last nudge was recent", () => {
		const recent = NOW - NUDGE_INTERVAL_MS / 2;
		expect(
			shouldNudge({ interlinkedDir: "/repo/.interlinked", now: NOW, readMtime: () => recent }),
		).toBe(false);
	});

	it("nudges again once the interval has elapsed", () => {
		const old = NOW - NUDGE_INTERVAL_MS;
		expect(shouldNudge({ interlinkedDir: "/repo/.interlinked", now: NOW, readMtime: () => old })).toBe(
			true,
		);
	});
});

describe("formatStaleBaselineWarning — stays quiet (negative cases)", () => {
	it("returns null when every baseline is fresh", () => {
		expect(
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				readMtime: reader(fresh()),
			}),
		).toBeNull();
	});

	it("returns null at exactly one day under the threshold", () => {
		const ages = Object.fromEntries(
			TRACKED_BASELINES.map((b) => [b.file, DEFAULT_STALE_AFTER_DAYS - 1]),
		);
		expect(
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				readMtime: reader(ages),
			}),
		).toBeNull();
	});

	it("honours a caller-supplied threshold that tolerates the age", () => {
		const ages = Object.fromEntries(TRACKED_BASELINES.map((b) => [b.file, 30]));
		expect(
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				staleAfterDays: 90,
				readMtime: reader(ages),
			}),
		).toBeNull();
	});
});

describe("formatStaleBaselineWarning — fires (positive cases)", () => {
	it("names a baseline that is past the threshold, with its age", () => {
		const out = formatStaleBaselineWarning({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader({ ...fresh(), "coverage-baseline.json": 44 }),
		});
		expect(out).toContain("coverage-baseline.json — 44d old");
		expect(out).toContain("[interlinked:baseline-staleness]");
	});

	it("treats an ABSENT baseline as stale — not measuring is not passing", () => {
		const missing = fresh();
		delete missing["mutation-baseline.json"];
		const out = formatStaleBaselineWarning({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader(missing),
		});
		expect(out).toContain("mutation-baseline.json — never generated");
	});

	it("fires exactly at the threshold boundary", () => {
		const out = formatStaleBaselineWarning({
			interlinkedDir: "/repo/.interlinked",
			now: NOW,
			readMtime: reader({ ...fresh(), "coverage-baseline.json": DEFAULT_STALE_AFTER_DAYS }),
		});
		expect(out).not.toBeNull();
	});

	it("lists each stale baseline and dedupes the refresh commands", () => {
		const out =
			formatStaleBaselineWarning({
				interlinkedDir: "/repo/.interlinked",
				now: NOW,
				readMtime: reader({ "coverage-baseline.json": 40, "coverage-edit-baseline.json": 40 }),
			}) ?? "";
		// Both coverage baselines share one refresh command; it must appear once.
		const occurrences = out.split("interlinked coverage check --update-baseline").length - 1;
		expect(occurrences).toBe(1);
		expect(out).toContain("coverage-baseline.json");
		expect(out).toContain("coverage-edit-baseline.json");
	});
});
