import { describe, expect, it } from "vitest";
import {
	checkArrayFromMap,
	checkAwaitInLoop,
	checkCloneInLoop,
	checkCollectThenIterate,
	checkDoubleTypeCast,
	checkFilterLength,
	checkJsonClonePattern,
	checkJsonInLoop,
	checkLenListGenerator,
	checkMallocInLoop,
	checkMathSpread,
	checkQueryInLoop,
	checkRegexInLoop,
	checkSortInLoop,
	checkSpreadInReduce,
	checkSprintfInLoop,
	checkStringConcatInLoop,
	checkStrlenInLoopCondition,
} from "../generic-checks.js";

describe("Performance checks — Tier 1", () => {
	describe("checkStrlenInLoopCondition", () => {
		it("detects strlen in for-loop condition", () => {
			const code = "for (int i = 0; i < strlen(s); i++) {\n    process(s[i]);\n}";
			expect(checkStrlenInLoopCondition(code, "parser.c").length).toBeGreaterThan(0);
		});
		it("does NOT flag strlen outside loop", () => {
			expect(checkStrlenInLoopCondition("size_t len = strlen(s);", "parser.c")).toEqual([]);
		});
		it("skips non-C files", () => {
			expect(checkStrlenInLoopCondition("for(;;strlen(s))", "parser.ts")).toEqual([]);
		});
	});

	describe("checkCollectThenIterate", () => {
		it("detects .collect().iter()", () => {
			const code = "let v: Vec<i32> = items.iter().collect().iter().map(|x| x + 1);";
			expect(checkCollectThenIterate(code, "lib.rs").length).toBeGreaterThan(0);
		});
		it("does NOT flag collect without iter", () => {
			expect(checkCollectThenIterate("let v: Vec<_> = items.collect();", "lib.rs")).toEqual(
				[],
			);
		});
		it("skips non-Rust files", () => {
			expect(checkCollectThenIterate(".collect().iter()", "lib.ts")).toEqual([]);
		});
	});

	describe("checkSpreadInReduce", () => {
		it("detects [...acc, item] in reduce", () => {
			const code =
				"const flat = arr.reduce((acc, item) => {\n    return [...acc, ...item];\n}, []);";
			expect(checkSpreadInReduce(code, "util.ts").length).toBeGreaterThan(0);
		});
		it("does NOT flag reduce without spread", () => {
			const code = "const sum = arr.reduce((acc, n) => acc + n, 0);";
			expect(checkSpreadInReduce(code, "util.ts")).toEqual([]);
		});
	});

	describe("checkAwaitInLoop", () => {
		it("detects await inside for loop", () => {
			const code = "for (const url of urls) {\n    const res = await fetch(url);\n}";
			expect(checkAwaitInLoop(code, "fetcher.ts").length).toBeGreaterThan(0);
		});
		it("does NOT flag for-await-of", () => {
			const code = "for await (const chunk of stream) {\n    process(chunk);\n}";
			expect(checkAwaitInLoop(code, "reader.ts")).toEqual([]);
		});
		it("does NOT flag await outside loop", () => {
			const code = "const data = await fetch(url);";
			expect(checkAwaitInLoop(code, "fetcher.ts")).toEqual([]);
		});
	});

	describe("checkQueryInLoop", () => {
		it("detects db.query inside for loop (JS)", () => {
			const code = `for (const id of ids) {\n    const row = await db.query("SELECT * FROM users WHERE id = ?", [id]);\n}`;
			expect(checkQueryInLoop(code, "users.ts").length).toBeGreaterThan(0);
		});
		it("detects cursor.execute inside for loop (Python)", () => {
			const code = `for user_id in user_ids:\n    cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))`;
			expect(checkQueryInLoop(code, "users.py").length).toBeGreaterThan(0);
		});
		it("does NOT flag query outside loop", () => {
			const code = `const rows = await db.query("SELECT * FROM users");`;
			expect(checkQueryInLoop(code, "users.ts")).toEqual([]);
		});
	});

	describe("checkStringConcatInLoop", () => {
		it("detects string += in Python loop", () => {
			const code = `for item in items:\n    result += f"{item}, "`;
			expect(checkStringConcatInLoop(code, "builder.py").length).toBeGreaterThan(0);
		});
		it("detects string += in Go loop", () => {
			const code = `for _, item := range items {\n    result += "prefix"\n}`;
			expect(checkStringConcatInLoop(code, "builder.go").length).toBeGreaterThan(0);
		});
		it("skips JS files (has different perf profile)", () => {
			expect(checkStringConcatInLoop('for(;;){ s += "x"; }', "builder.ts")).toEqual([]);
		});
	});

	describe("checkJsonClonePattern", () => {
		it("detects JSON round-trip clone", () => {
			const code = "const copy = JSON.parse(JSON.stringify(original));";
			expect(checkJsonClonePattern(code, "utils.ts").length).toBeGreaterThan(0);
		});
		it("does NOT flag separate parse and stringify", () => {
			const code = "const str = JSON.stringify(obj);\nconst parsed = JSON.parse(input);";
			expect(checkJsonClonePattern(code, "utils.ts")).toEqual([]);
		});
	});

	describe("checkFilterLength", () => {
		it("detects .filter().length", () => {
			const code = "const count = items.filter(x => x.active).length;";
			expect(checkFilterLength(code, "stats.ts").length).toBeGreaterThan(0);
		});
		it("does NOT flag .filter() without .length", () => {
			expect(
				checkFilterLength("const active = items.filter(x => x.active);", "stats.ts"),
			).toEqual([]);
		});
	});

	describe("checkRegexInLoop", () => {
		it("detects new RegExp in JS loop", () => {
			const code = "for (const s of strings) {\n    const re = new RegExp(pattern);\n}";
			expect(checkRegexInLoop(code, "parser.ts").length).toBeGreaterThan(0);
		});
		it("detects re.compile in Python loop", () => {
			const code = `for line in lines:\n    pat = re.compile(r"\\d+")`;
			expect(checkRegexInLoop(code, "parser.py").length).toBeGreaterThan(0);
		});
		it("does NOT flag RegExp outside loop", () => {
			expect(checkRegexInLoop("const re = new RegExp('abc');", "parser.ts")).toEqual([]);
		});
	});

	describe("checkCloneInLoop", () => {
		it("detects .clone() in Rust loop", () => {
			const code = "for item in &items {\n    let copy = item.clone();\n}";
			expect(checkCloneInLoop(code, "process.rs").length).toBeGreaterThan(0);
		});
		it("does NOT flag .clone() outside loop", () => {
			expect(checkCloneInLoop("let copy = original.clone();", "process.rs")).toEqual([]);
		});
	});

	describe("checkMathSpread", () => {
		it("detects Math.max(...arr)", () => {
			expect(
				checkMathSpread("const m = Math.max(...values);", "stats.ts").length,
			).toBeGreaterThan(0);
		});
		it("detects Math.min(...arr)", () => {
			expect(
				checkMathSpread("const m = Math.min(...values);", "stats.ts").length,
			).toBeGreaterThan(0);
		});
		it("does NOT flag Math.max with explicit args", () => {
			expect(checkMathSpread("const m = Math.max(a, b, c);", "stats.ts")).toEqual([]);
		});
	});
});

describe("Performance checks — Tier 2", () => {
	describe("checkSortInLoop", () => {
		it("detects .sort() in JS loop", () => {
			const code = "for (let i = 0; i < n; i++) {\n    arr.sort();\n}";
			expect(checkSortInLoop(code, "sorter.ts").length).toBeGreaterThan(0);
		});
		it("does NOT flag .sort() outside loop", () => {
			expect(checkSortInLoop("arr.sort();", "sorter.ts")).toEqual([]);
		});
	});

	describe("checkJsonInLoop", () => {
		it("detects JSON.parse in loop", () => {
			const code = "for (const s of strings) {\n    const obj = JSON.parse(s);\n}";
			expect(checkJsonInLoop(code, "parser.ts").length).toBeGreaterThan(0);
		});
		it("detects json.loads in Python loop", () => {
			const code = "for line in lines:\n    data = json.loads(line)";
			expect(checkJsonInLoop(code, "parser.py").length).toBeGreaterThan(0);
		});
	});

	describe("checkArrayFromMap", () => {
		it("detects Array.from(x).map(fn)", () => {
			expect(
				checkArrayFromMap("Array.from(set).map(x => x * 2)", "util.ts").length,
			).toBeGreaterThan(0);
		});
		it("does NOT flag Array.from with mapper arg", () => {
			expect(checkArrayFromMap("Array.from(set, x => x * 2)", "util.ts")).toEqual([]);
		});
	});

	describe("checkMallocInLoop", () => {
		it("detects malloc in loop without free", () => {
			const code =
				"for (int i = 0; i < n; i++) {\n    char *buf = malloc(256);\n    process(buf);\n}";
			expect(checkMallocInLoop(code, "alloc.c").length).toBeGreaterThan(0);
		});
		it("does NOT flag malloc with free in same loop", () => {
			const code =
				"for (int i = 0; i < n; i++) {\n    char *buf = malloc(256);\n    process(buf);\n    free(buf);\n}";
			expect(checkMallocInLoop(code, "alloc.c")).toEqual([]);
		});
	});

	describe("checkSprintfInLoop", () => {
		it("detects fmt.Sprintf in Go loop", () => {
			const code = `for _, v := range items {\n    s := fmt.Sprintf("%d", v)\n}`;
			expect(checkSprintfInLoop(code, "format.go").length).toBeGreaterThan(0);
		});
		it("skips non-Go files", () => {
			expect(checkSprintfInLoop("fmt.Sprintf()", "format.ts")).toEqual([]);
		});
	});

	describe("checkDoubleTypeCast", () => {
		it("detects as unknown as T", () => {
			expect(
				checkDoubleTypeCast("const x = value as unknown as TargetType;", "cast.ts").length,
			).toBeGreaterThan(0);
		});
		it("does NOT flag single as cast", () => {
			expect(checkDoubleTypeCast("const x = value as string;", "cast.ts")).toEqual([]);
		});
		it("skips non-TS files", () => {
			expect(checkDoubleTypeCast("as unknown as T", "cast.js")).toEqual([]);
		});
	});

	describe("checkLenListGenerator", () => {
		it("detects len(list(generator))", () => {
			expect(
				checkLenListGenerator("n = len(list(get_items()))", "count.py").length,
			).toBeGreaterThan(0);
		});
		it("does NOT flag len(list_var)", () => {
			expect(checkLenListGenerator("n = len(my_list)", "count.py")).toEqual([]);
		});
		it("skips non-Python files", () => {
			expect(checkLenListGenerator("len(list(x))", "count.ts")).toEqual([]);
		});
	});
});
