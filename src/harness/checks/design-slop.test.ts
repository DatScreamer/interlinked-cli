import { describe, expect, it } from "vitest";
import { detectDesignSlop } from "./design-slop.js";

/** Collect the firing sub-rule tags (the `[rule]` prefix) from findings. */
function rules(content: string, file = "page.html"): string[] {
	return detectDesignSlop(content, file).map((m) => {
		const tag = m.text.match(/^\[([^\]]+)\]/);
		return tag?.[1] ?? "";
	});
}

describe("detectDesignSlop — scope", () => {
	it("ignores non-design files (.ts/.js stay untouched)", () => {
		const css = "h1 { font-family: Inter; }";
		expect(detectDesignSlop(css, "src/widget.ts")).toEqual([]);
		expect(detectDesignSlop(css, "src/widget.js")).toEqual([]);
		expect(detectDesignSlop(css, "README.md")).toEqual([]);
	});

	it("runs on design surfaces (.html/.css/.tsx/.vue/.svelte)", () => {
		const css = "h1 { font-family: Inter; }";
		for (const f of ["a.html", "a.css", "a.tsx", "a.vue", "a.svelte", "a.astro"]) {
			expect(detectDesignSlop(css, f).length).toBeGreaterThan(0);
		}
	});

	it("returns InlineMatch shape with 1-based line numbers", () => {
		const html = "<div>\n  <h1 style=\"font-family: Inter\">Hi</h1>\n</div>";
		const found = detectDesignSlop(html, "a.html");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]).toMatchObject({ line: 2 });
		expect(typeof found[0]?.text).toBe("string");
	});

	it("caps findings per file", () => {
		const spam = Array.from({ length: 50 }, () => "p { font-family: Inter; }").join("\n");
		expect(detectDesignSlop(spam, "a.css").length).toBeLessThanOrEqual(12);
	});
});

describe("overused-font (positive)", () => {
	it.each([
		"body { font-family: Inter, sans-serif; }",
		"h1 { font-family: 'Plus Jakarta Sans'; }",
		'<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk" rel="stylesheet">',
	])("flags %s", (src) => {
		expect(rules(src, "a.html")).toContain("overused-font");
	});
});

describe("overused-font (negative)", () => {
	it.each([
		"body { font-family: 'GT Sectra', serif; }",
		"h1 { font-family: Georgia, serif; }",
		'<link href="https://fonts.googleapis.com/css2?family=Sentient" rel="stylesheet">',
	])("does not flag %s", (src) => {
		expect(rules(src, "a.html")).not.toContain("overused-font");
	});
});

describe("side-tab accent border (positive)", () => {
	it.each([
		'<div class="border-l-4 rounded-lg bg-white">card</div>',
		".card { border-left: 4px solid #8b5cf6; border-radius: 12px; }",
		".alert { border-left: 3px solid rebeccapurple; }",
	])("flags %s", (src) => {
		expect(rules(src, "a.html")).toContain("side-tab");
	});
});

describe("side-tab accent border (negative — FP guards)", () => {
	it("does not flag a neutral (gray) side border", () => {
		expect(rules(".x { border-left: 4px solid #cccccc; }", "a.css")).not.toContain("side-tab");
	});
	it("does not flag a blockquote bar (safe element)", () => {
		expect(rules('<blockquote style="border-left: 4px solid teal">q</blockquote>', "a.html")).not.toContain(
			"side-tab",
		);
	});
	it("does not flag a thin 1px rule", () => {
		expect(rules(".x { border-left: 1px solid #8b5cf6; }", "a.css")).not.toContain("side-tab");
	});
	it("does not flag border-l-2 on a non-rounded element", () => {
		expect(rules('<div class="border-l-2">x</div>', "a.html")).not.toContain("side-tab");
	});
	it("does not flag a named neutral (gray/silver) side border", () => {
		expect(rules(".x { border-left: 4px solid gray; border-radius: 8px; }", "a.css")).not.toContain(
			"side-tab",
		);
		expect(rules(".y { border-left: 4px solid silver; }", "a.css")).not.toContain("side-tab");
	});
	it("does not flag a 3-digit neutral hex side border", () => {
		expect(rules(".x { border-left: 4px solid #ccc; }", "a.css")).not.toContain("side-tab");
	});
	it("flags a saturated 3-digit hex side border", () => {
		expect(rules(".x { border-left: 4px solid #80f; }", "a.css")).toContain("side-tab");
	});
});

describe("gradient-text (positive/negative)", () => {
	it("flags background-clip:text paired with a gradient", () => {
		expect(
			rules(".h { background: linear-gradient(90deg,#f00,#00f); background-clip: text; }", "a.css"),
		).toContain("gradient-text");
	});
	it("flags bg-clip-text + bg-gradient (Tailwind)", () => {
		expect(rules('<h1 class="bg-clip-text bg-gradient-to-r">t</h1>', "a.html")).toContain("gradient-text");
	});
	it("does not flag background-clip:text without a gradient (icon masks)", () => {
		expect(rules(".i { background-clip: text; background: #111; }", "a.css")).not.toContain("gradient-text");
	});
	it("does not flag a plain background gradient", () => {
		expect(rules(".bg { background: linear-gradient(90deg,#f00,#00f); }", "a.css")).not.toContain(
			"gradient-text",
		);
	});
});

describe("ai-color-palette (positive/negative)", () => {
	it("flags a purple→violet Tailwind gradient", () => {
		expect(rules('<div class="bg-gradient-to-r from-purple-500 to-violet-600">x</div>', "a.html")).toContain(
			"ai-color-palette",
		);
	});
	it("does not flag a from-purple with a warm to- color (not the AI signature)", () => {
		expect(rules('<div class="from-purple-500 to-amber-400">x</div>', "a.html")).not.toContain(
			"ai-color-palette",
		);
	});
	it("does not flag a lone from-purple with no to-", () => {
		expect(rules('<div class="from-purple-500">x</div>', "a.html")).not.toContain("ai-color-palette");
	});
});

describe("bounce-easing (positive/negative)", () => {
	it.each([
		'<div class="animate-bounce">x</div>',
		".x { animation: bounce 1s; }",
		".x { transition-timing-function: cubic-bezier(0.68, -0.55, 0.27, 1.55); }",
	])("flags %s", (src) => {
		expect(rules(src, "a.html")).toContain("bounce-easing");
	});
	it("does not flag a normal ease-out cubic-bezier", () => {
		expect(rules(".x { transition: all .3s cubic-bezier(0.22, 1, 0.36, 1); }", "a.css")).not.toContain(
			"bounce-easing",
		);
	});
	it("does not flag a transition that merely contains the word ease", () => {
		expect(rules(".x { transition: opacity .2s ease-out; }", "a.css")).not.toContain("bounce-easing");
	});
});

describe("gray-on-color (positive/negative)", () => {
	it("flags gray text on a colored bg", () => {
		expect(rules('<span class="text-gray-500 bg-blue-600">hi</span>', "a.html")).toContain("gray-on-color");
	});
	it("does not flag gray text on a neutral bg", () => {
		expect(rules('<span class="text-gray-500 bg-white">hi</span>', "a.html")).not.toContain("gray-on-color");
	});
	it("does not flag colored text on a colored bg", () => {
		expect(rules('<span class="text-white bg-blue-600">hi</span>', "a.html")).not.toContain("gray-on-color");
	});
});

describe("broken-image (positive/negative)", () => {
	it.each(['<img src="">', "<img src='#'>", '<img src="   ">'])("flags %s", (src) => {
		expect(rules(src, "a.html")).toContain("broken-image");
	});
	it("does not flag an image with a real src", () => {
		expect(rules('<img src="/logo.png" alt="logo">', "a.html")).not.toContain("broken-image");
	});
	it("does not flag a templated src", () => {
		expect(rules('<img src={logoUrl} alt="logo">', "a.tsx")).not.toContain("broken-image");
	});
});

describe("copy tells — em-dash overuse & buzzwords (positive/negative)", () => {
	it("flags 5+ em-dashes in body text", () => {
		const html = "<p>a — b — c — d — e — f</p>";
		expect(rules(html, "a.html")).toContain("em-dash-overuse");
	});
	it("does not flag occasional em-dash use", () => {
		expect(rules("<p>a — b, then c.</p>", "a.html")).not.toContain("em-dash-overuse");
	});
	it("does not count em-dashes inside <style>/<script>", () => {
		const html = "<style>/* — — — — — — */</style><p>clean copy</p>";
		expect(rules(html, "a.html")).not.toContain("em-dash-overuse");
	});
	it("flags marketing buzzwords", () => {
		expect(rules("<h2>Supercharge your workflow with our world-class platform</h2>", "a.html")).toContain(
			"marketing-buzzword",
		);
	});
	it("does not flag plain product copy", () => {
		expect(rules("<h2>Track your team's deploys in one place</h2>", "a.html")).not.toContain(
			"marketing-buzzword",
		);
	});
});
