import { describe, expect, it } from "vitest";
import { NAMED_ENTITIES } from "./entity-names.js";

describe("NAMED_ENTITIES", () => {
	it("keys are lowercase entity names (consumer case-folds lookups)", () => {
		for (const key of Object.keys(NAMED_ENTITIES)) {
			expect(key).toBe(key.toLowerCase());
			expect(key).toMatch(/^[a-z][a-z0-9]{0,30}$/);
		}
	});

	it("every glyph is a single code point (the consumer's \\p{L} test reads it whole)", () => {
		for (const glyph of Object.values(NAMED_ENTITIES)) {
			expect([...glyph]).toHaveLength(1);
		}
	});

	it("carries the five reserved names plus the letter/symbol split the slugger relies on", () => {
		expect(NAMED_ENTITIES.amp).toBe("&");
		expect(NAMED_ENTITIES.lt).toBe("<");
		expect(NAMED_ENTITIES.gt).toBe(">");
		expect(NAMED_ENTITIES.quot).toBe('"');
		expect(NAMED_ENTITIES.apos).toBe("'");
		// A letter entity (renders into slugs) and symbol entities (strip to "").
		expect(/\p{L}/u.test(NAMED_ENTITIES.eacute ?? "")).toBe(true);
		expect(/\p{L}/u.test(NAMED_ENTITIES.nbsp ?? "")).toBe(false);
		expect(/\p{L}/u.test(NAMED_ENTITIES.frac12 ?? "")).toBe(false);
	});
});
