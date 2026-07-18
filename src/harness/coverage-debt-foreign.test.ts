import { describe, expect, it } from "vitest";
import { attachWarning, fmtAge, foreignDebtNote } from "./coverage-debt-foreign.js";
import { obligationId, type Obligation } from "./obligations.js";

function debt(kind: "coverage" | "red_suite", file: string, openedAtMs: number): Obligation {
	return {
		id: obligationId(kind, file),
		kind,
		file,
		contentHash: "",
		status: "open",
		sessionId: "other-session",
		openedAtMs,
	};
}

describe("fmtAge", () => {
	it("renders sub-minute ages as moments", () => {
		expect(fmtAge(20_000)).toBe("moments");
	});

	it("renders minute-scale ages in minutes", () => {
		expect(fmtAge(25 * 60_000)).toBe("25m");
	});

	it("renders hour-scale ages in hours", () => {
		expect(fmtAge(5 * 3_600_000)).toBe("5h");
	});

	it("renders multi-day ages in days", () => {
		expect(fmtAge(3 * 86_400_000)).toBe("3d");
	});
});

describe("foreignDebtNote", () => {
	it("describes a coverage debt without accusing the reader", () => {
		const note = foreignDebtNote(debt("coverage", "src/a.ts", 0), 10 * 60_000);
		expect(note).toContain("another session");
		expect(note).toContain("src/a.ts");
		expect(note).toContain("~10m ago");
		expect(note).not.toContain("you added");
	});

	it("describes a red-suite debt as drive-green work", () => {
		const note = foreignDebtNote(debt("red_suite", "src/b.ts", 0), 3_600_000);
		expect(note).toContain("RED");
		expect(note).toContain("src/b.ts");
		expect(note).toContain("~60m ago");
	});

	it("clamps a clock-skewed future openedAtMs to a non-negative age", () => {
		const note = foreignDebtNote(debt("coverage", "src/c.ts", 999_999), 0);
		expect(note).toContain("~moments ago");
	});
});

describe("attachWarning", () => {
	it("returns the decision unchanged when there is no note", () => {
		const d = { decision: "allow" as const, warnings: ["w"] };
		expect(attachWarning(d, null)).toBe(d);
		expect(attachWarning(null, null)).toBeNull();
	});

	it("turns a plain allow (null) into an allow carrying the note", () => {
		expect(attachWarning(null, "note")).toEqual({ decision: "allow", warnings: ["note"] });
	});

	it("appends the note after an existing decision's own warnings", () => {
		const out = attachWarning({ decision: "allow", warnings: ["first"] }, "note");
		expect(out?.warnings).toEqual(["first", "note"]);
	});

	it("appends to a passthrough block without changing its verdict", () => {
		const out = attachWarning({ decision: "block", reason: "r" }, "note");
		expect(out?.decision).toBe("block");
		expect(out?.warnings).toEqual(["note"]);
	});
});
