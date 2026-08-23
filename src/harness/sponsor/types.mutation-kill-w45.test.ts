import { describe, expect, it } from "vitest";
import {
	activeCreatives,
	feedIsLive,
	parseFeedPayload,
	sanitizeCreative,
	type SponsorFeed,
} from "./types.js";

const VALID_URL = "https://example.com/click";

describe("sanitizeCreative — positive/negative (must fire)", () => {
	it("rejects a non-object raw value (string)", () => {
		expect(sanitizeCreative("not-an-object")).toBeNull();
	});

	it("rejects a non-object raw value (number)", () => {
		expect(sanitizeCreative(42)).toBeNull();
	});

	it("rejects when id is not a string", () => {
		const raw = { id: 123, campaign: "c1", text: "hi", url: VALID_URL, weight: 1 };
		expect(sanitizeCreative(raw)).toBeNull();
	});

	it("trims stripped text rather than leaving surrounding whitespace", () => {
		const raw = {
			id: "abc",
			campaign: "c1",
			text: "  hello world  ",
			url: VALID_URL,
			weight: 1,
		};
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.text).toBe("hello world");
	});

	it("rejects when url is not a string", () => {
		const raw = { id: "abc", campaign: "c1", text: "hi", url: 12345, weight: 1 };
		expect(sanitizeCreative(raw)).toBeNull();
	});

	it("trims stripped url rather than leaving surrounding whitespace", () => {
		const raw = {
			id: "abc",
			campaign: "c1",
			text: "hi",
			url: "  https://example.com  ",
			weight: 1,
		};
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.url).toBe("https://example.com");
	});

	it("defaults weight to 1 when weight is NaN (typeof number but not finite)", () => {
		const raw = { id: "abc", campaign: "c1", text: "hi", url: VALID_URL, weight: Number.NaN };
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.weight).toBe(1);
	});

	it("does not set starts_at when it fails the typeof-string check, even if it would parse as a date", () => {
		const raw = {
			id: "abc",
			campaign: "c1",
			text: "hi",
			url: VALID_URL,
			weight: 1,
			starts_at: new Date(1700000000000),
		};
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.starts_at).toBeUndefined();
	});

	it("does not set starts_at when it is a string but not a valid ISO date", () => {
		const raw = {
			id: "abc",
			campaign: "c1",
			text: "hi",
			url: VALID_URL,
			weight: 1,
			starts_at: "not-a-real-date",
		};
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.starts_at).toBeUndefined();
	});

	it("does not set starts_at when it fails validation entirely (non-string, non-date-parseable)", () => {
		const raw = {
			id: "abc",
			campaign: "c1",
			text: "hi",
			url: VALID_URL,
			weight: 1,
			starts_at: 99999999,
		};
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.starts_at).toBeUndefined();
	});

	it("does not set ends_at when it fails the typeof-string check, even if it would parse as a date", () => {
		const raw = {
			id: "abc",
			campaign: "c1",
			text: "hi",
			url: VALID_URL,
			weight: 1,
			ends_at: new Date(1700000000000),
		};
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.ends_at).toBeUndefined();
	});

	it("rejects id that does not match the charset anchored at the start", () => {
		const raw = { id: "!!!abc", campaign: "c1", text: "hi", url: VALID_URL, weight: 1 };
		expect(sanitizeCreative(raw)).toBeNull();
	});

	it("rejects id that does not match the charset anchored at the end", () => {
		const raw = { id: "abc$$$", campaign: "c1", text: "hi", url: VALID_URL, weight: 1 };
		expect(sanitizeCreative(raw)).toBeNull();
	});

	it("accepts a well-formed id unchanged", () => {
		const raw = { id: "sponsor-1", campaign: "c1", text: "hi", url: VALID_URL, weight: 1 };
		const result = sanitizeCreative(raw);
		expect(result).not.toBeNull();
		expect(result?.id).toBe("sponsor-1");
	});
});

describe("parseFeedPayload — positive/negative (must fire)", () => {
	it("returns null (without throwing) for a JSON payload of literal null", () => {
		let result: SponsorFeed | null | undefined;
		expect(() => {
			result = parseFeedPayload("null");
		}).not.toThrow();
		expect(result).toBeNull();
	});

	it("rejects when generated_at is not a valid-ISO string", () => {
		const json = JSON.stringify({
			version: 1,
			generated_at: 123,
			valid_until: "2026-01-01T00:00:00Z",
			creatives: [],
		});
		expect(parseFeedPayload(json)).toBeNull();
	});

	it("rejects when generated_at is a string but not a parseable date", () => {
		const json = JSON.stringify({
			version: 1,
			generated_at: "not-a-date",
			valid_until: "2026-01-01T00:00:00Z",
			creatives: [],
		});
		expect(parseFeedPayload(json)).toBeNull();
	});

	it("rejects when valid_until is not a valid-ISO string", () => {
		const json = JSON.stringify({
			version: 1,
			generated_at: "2026-01-01T00:00:00Z",
			valid_until: 456,
			creatives: [],
		});
		expect(parseFeedPayload(json)).toBeNull();
	});

	it("rejects when valid_until is a string but not a parseable date", () => {
		const json = JSON.stringify({
			version: 1,
			generated_at: "2026-01-01T00:00:00Z",
			valid_until: "not-a-date",
			creatives: [],
		});
		expect(parseFeedPayload(json)).toBeNull();
	});

	it("rejects a feed whose creatives array exceeds MAX_CREATIVES, accepts exactly the cap", () => {
		const atCap = JSON.stringify({
			version: 1,
			generated_at: "2026-01-01T00:00:00Z",
			valid_until: "2027-01-01T00:00:00Z",
			creatives: new Array(20).fill(null),
		});
		expect(parseFeedPayload(atCap)).not.toBeNull();

		const overCap = JSON.stringify({
			version: 1,
			generated_at: "2026-01-01T00:00:00Z",
			valid_until: "2027-01-01T00:00:00Z",
			creatives: new Array(21).fill(null),
		});
		expect(parseFeedPayload(overCap)).toBeNull();
	});
});

describe("feedIsLive — positive/negative (must fire)", () => {
	it("treats a feed as not live at the exact valid_until instant", () => {
		const validUntil = "2026-06-01T00:00:00.000Z";
		const feed: SponsorFeed = {
			version: 1,
			generated_at: "2026-01-01T00:00:00.000Z",
			valid_until: validUntil,
			creatives: [],
		};
		const exactMs = Date.parse(validUntil);
		expect(feedIsLive(feed, exactMs)).toBe(false);
		expect(feedIsLive(feed, exactMs - 1)).toBe(true);
	});
});

describe("activeCreatives — positive/negative (must fire)", () => {
	it("includes a creative whose starts_at has already passed", () => {
		const startsAt = "2026-01-01T00:00:00.000Z";
		const feed: SponsorFeed = {
			version: 1,
			generated_at: "2026-01-01T00:00:00.000Z",
			valid_until: "2027-01-01T00:00:00.000Z",
			creatives: [
				{
					id: "c1",
					campaign: "cmp",
					text: "hi",
					url: VALID_URL,
					weight: 1,
					starts_at: startsAt,
				},
			],
		};
		const nowMs = Date.parse(startsAt) + 1000;
		expect(activeCreatives(feed, nowMs)).toHaveLength(1);
	});

	it("includes a creative exactly at its starts_at instant (boundary is inclusive)", () => {
		const startsAt = "2026-01-01T00:00:00.000Z";
		const feed: SponsorFeed = {
			version: 1,
			generated_at: "2026-01-01T00:00:00.000Z",
			valid_until: "2027-01-01T00:00:00.000Z",
			creatives: [
				{
					id: "c1",
					campaign: "cmp",
					text: "hi",
					url: VALID_URL,
					weight: 1,
					starts_at: startsAt,
				},
			],
		};
		const nowMs = Date.parse(startsAt);
		expect(activeCreatives(feed, nowMs)).toHaveLength(1);
	});

	it("includes a creative whose ends_at has not yet arrived", () => {
		const endsAt = "2030-01-01T00:00:00.000Z";
		const feed: SponsorFeed = {
			version: 1,
			generated_at: "2026-01-01T00:00:00.000Z",
			valid_until: "2031-01-01T00:00:00.000Z",
			creatives: [
				{ id: "c1", campaign: "cmp", text: "hi", url: VALID_URL, weight: 1, ends_at: endsAt },
			],
		};
		const nowMs = Date.parse(endsAt) - 1000;
		expect(activeCreatives(feed, nowMs)).toHaveLength(1);
	});

	it("excludes a creative exactly at its ends_at instant (boundary is exclusive)", () => {
		const endsAt = "2030-01-01T00:00:00.000Z";
		const feed: SponsorFeed = {
			version: 1,
			generated_at: "2026-01-01T00:00:00.000Z",
			valid_until: "2031-01-01T00:00:00.000Z",
			creatives: [
				{ id: "c1", campaign: "cmp", text: "hi", url: VALID_URL, weight: 1, ends_at: endsAt },
			],
		};
		const nowMs = Date.parse(endsAt);
		expect(activeCreatives(feed, nowMs)).toHaveLength(0);
	});
});
