import { describe, expect, it } from "vitest";
import {
	checkDemoDataUnmarked,
	checkDemoRuntimeMissingBanner,
	checkPlaceholderDataInUi,
	checkSilentDemoFallback,
} from "./demo-data.js";

const TS = "src/lib/foo.ts";
const TEST = "src/lib/foo.test.ts";
const APP = "src/app/page.tsx";

describe("checkDemoDataUnmarked", () => {
	it("flags test emails (foo@example.com)", () => {
		const code = `const users = [{ email: "alice@example.com" }];`;
		const matches = checkDemoDataUnmarked(code, TS);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Stripe test card numbers", () => {
		const code = `const card = "4242424242424242";`;
		expect(checkDemoDataUnmarked(code, TS).length).toBeGreaterThan(0);
	});

	it("flags lorem ipsum", () => {
		const code = `const text = "Lorem ipsum dolor sit amet";`;
		expect(checkDemoDataUnmarked(code, TS).length).toBeGreaterThan(0);
	});

	it("flags faker import", () => {
		const code = `import { faker } from "@faker-js/faker";`;
		expect(checkDemoDataUnmarked(code, TS).length).toBeGreaterThan(0);
	});

	it("flags identifier prefixes (mockUsers, fakeData, sampleX)", () => {
		const code = `const mockUsers = []; const fakeData = {}; const sampleOrders = [];`;
		expect(checkDemoDataUnmarked(code, TS).length).toBeGreaterThanOrEqual(3);
	});

	it("flags sentinel UUIDs", () => {
		const code = `const id = "00000000-0000-0000-0000-000000000000";`;
		expect(checkDemoDataUnmarked(code, TS).length).toBeGreaterThan(0);
	});

	it("does not fire when @demo-data directive is present", () => {
		const code = `
// @demo-data: revenue chart pending API integration
const revenue = [{ email: "alice@example.com" }];
`;
		expect(checkDemoDataUnmarked(code, TS)).toEqual([]);
	});

	it("does not fire on test files", () => {
		const code = `const u = [{ email: "alice@example.com" }];`;
		expect(checkDemoDataUnmarked(code, TEST)).toEqual([]);
	});

	it("does not fire on __fixtures__ files", () => {
		expect(
			checkDemoDataUnmarked(
				`const u = [{ email: "alice@example.com" }];`,
				"src/__fixtures__/users.ts",
			),
		).toEqual([]);
	});
});

describe("checkSilentDemoFallback", () => {
	it("flags try { fetch } catch { return literal }", () => {
		const code = `
async function loadUsers() {
  try {
    return await fetch("/api/users").then(r => r.json());
  } catch {
    return [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
  }
}
`;
		const matches = checkSilentDemoFallback(code, TS);
		expect(matches.length).toBe(1);
	});

	it("does not fire when catch rethrows", () => {
		const code = `
try { return await fetch("/api"); } catch (e) { throw e; }
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire when catch returns a non-literal", () => {
		const code = `
try { return await fetch("/api"); } catch { return defaultData; }
`;
		expect(checkSilentDemoFallback(code, TS)).toEqual([]);
	});

	it("does not fire in test files", () => {
		const code = `try { fetch(); } catch { return [{a:1}]; }`;
		expect(checkSilentDemoFallback(code, TEST)).toEqual([]);
	});
});

describe("checkDemoRuntimeMissingBanner", () => {
	it("flags root layout that imports demoData but no DemoBanner", () => {
		const code = `
import { demoData } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`;
		const matches = checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx");
		expect(matches.length).toBe(1);
	});

	it("does not fire when DemoBanner is mounted", () => {
		const code = `
import { DemoBanner } from "@interlinked/demo-runtime";
export default function Layout({ children }) {
  return <html><body><DemoBanner />{children}</body></html>;
}
`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});

	it("does not fire on non-root files", () => {
		const code = `import { demoData } from "@interlinked/demo-runtime"; const x = demoData("a", []);`;
		expect(checkDemoRuntimeMissingBanner(code, "src/lib/foo.ts")).toEqual([]);
	});

	it("does not fire on root files that don't import demo runtime", () => {
		const code = `export default function Layout({ children }) { return <>{children}</>; }`;
		expect(checkDemoRuntimeMissingBanner(code, "src/app/layout.tsx")).toEqual([]);
	});
});

describe("checkPlaceholderDataInUi", () => {
	const UI = "src/components/Dashboard.tsx";

	it("flags a sequential-digit run rendered as text", () => {
		const code = `export const Stat = () => <span className="count">123456</span>;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a repeated-digit run rendered as a JSX child", () => {
		const code = `export const Stat = () => <div>{99999}</div>;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a mock-named value in a visible attribute", () => {
		const code = `export const Card = () => <Stat label="Revenue" value={mockRevenue} />;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags lorem ipsum rendered as copy", () => {
		const code = `export const Hero = () => <p>Lorem ipsum dolor sit amet consectetur</p>;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a known placeholder-image host", () => {
		const code = `export const Avatar = () => <img src="https://placehold.co/64x64" alt="u" />;`;
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("flags a hardcoded number a nearby comment marks as placeholder", () => {
		const code = [
			"export function Mrr() {",
			"  // placeholder until the revenue API lands",
			'  return <Stat value="12,847" />;',
			"}",
		].join("\n");
		expect(checkPlaceholderDataInUi(code, UI).length).toBeGreaterThan(0);
	});

	it("does not fire on a real value passed through an identifier", () => {
		const code = `export const Card = () => <Stat label="Revenue" value={revenue} />;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on a plausible, non-placeholder-shaped number", () => {
		const code = `export const Price = () => <Stat value="$1,234" />;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on an input placeholder attribute", () => {
		const code = `export const Search = () => <input placeholder="Search products" />;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on a non-UI file", () => {
		const code = `export const data = { count: 123456, label: "Lorem ipsum dolor" };`;
		expect(checkPlaceholderDataInUi(code, "src/lib/stats.ts")).toEqual([]);
	});

	it("is suppressed when the UI renders a visible sample-data disclaimer", () => {
		const code = [
			"export const Dashboard = () => (",
			"  <div>",
			"    <Banner>Sample data — these figures are illustrative</Banner>",
			"    <span>123456</span>",
			"  </div>",
			");",
		].join("\n");
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});

	it("does not fire on commented-out markup", () => {
		const code = `export const X = () => <div>{/* <span>123456</span> */}</div>;`;
		expect(checkPlaceholderDataInUi(code, UI)).toEqual([]);
	});
});
