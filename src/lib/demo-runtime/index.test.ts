import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DemoBanner,
	__resetDemoRegistry,
	demoData,
	demoStateSummary,
	mountDemoBanner,
} from "./index.js";
import { nonNull } from "../non-null.js";

describe("demoData", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	it("returns the wrapped value unchanged", () => {
		const arr = [{ id: 1, name: "alice" }];
		expect(demoData("users", arr)).toBe(arr);
	});

	it("registers the key + reason in the runtime registry", () => {
		demoData("revenue", [{ x: 1 }], { reason: "API pending", ticket: "TICKET-9" });
		const summary = demoStateSummary();
		expect(summary.entries.length).toBe(1);
		expect(nonNull(summary.entries[0]).key).toBe("revenue");
		expect(nonNull(summary.entries[0]).reason).toBe("API pending");
		expect(nonNull(summary.entries[0]).ticket).toBe("TICKET-9");
	});

	it("dedupes by key", () => {
		demoData("users", []);
		demoData("users", [{ a: 1 }]);
		expect(demoStateSummary().entries.length).toBe(1);
	});

	it("supports multiple distinct keys", () => {
		demoData("users", []);
		demoData("orders", []);
		demoData("revenue", []);
		expect(demoStateSummary().entries.length).toBe(3);
	});

	it("exposes a non-empty banner-text helper when entries exist", () => {
		demoData("revenue", []);
		expect(demoStateSummary().bannerText).toContain("DEMO DATA");
		expect(demoStateSummary().bannerText).toContain("revenue");
	});

	it("returns an empty banner when nothing is wrapped", () => {
		expect(demoStateSummary().bannerText).toBe("");
	});
});

describe("mountDemoBanner / DemoBanner (vanilla DOM)", () => {
	beforeEach(() => __resetDemoRegistry());
	afterEach(() => __resetDemoRegistry());

	it("returns a no-op unmount when there is no document (Node)", () => {
		// In a non-DOM environment the banner mounts nothing and returns
		// a callable unmount that's safe to invoke.
		const unmount = mountDemoBanner();
		expect(typeof unmount).toBe("function");
		unmount();
	});

	it("DemoBanner is exported as the JSX-friendly alias of mountDemoBanner", () => {
		// The check warning instructs `<DemoBanner />` import; we ship a
		// JSX-shaped React-component compatible function so plain JSX
		// `<DemoBanner />` calls work in React/Preact codebases without
		// taking on a framework dependency in this package.
		expect(typeof DemoBanner).toBe("function");
	});
});
