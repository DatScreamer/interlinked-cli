import { describe, expect, it } from "vitest";
import {
	checkCIncludeGuard,
	checkCSprintfUsage,
	checkCStrcmpBooleanMisuse,
	checkCUncheckedMalloc,
	checkCUnsafeFunctions,
} from "../generic-checks.js";

// ===========================================
// checkCUnsafeFunctions
// ===========================================

describe("checkCUnsafeFunctions", () => {
	it("detects strcpy", () => {
		const code = "#include <string.h>\nvoid f() { strcpy(dst, src); }";
		const matches = checkCUnsafeFunctions(code, "util.c");
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(2);
	});

	it("detects strcat", () => {
		const code = "strcat(buf, input);";
		const matches = checkCUnsafeFunctions(code, "main.c");
		expect(matches.length).toBe(1);
	});

	it("detects gets", () => {
		const code = "char buf[64];\ngets(buf);";
		const matches = checkCUnsafeFunctions(code, "io.c");
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(2);
	});

	it("detects sprintf", () => {
		const code = 'sprintf(buf, "%s", name);';
		const matches = checkCUnsafeFunctions(code, "fmt.c");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag strncpy", () => {
		const code = "strncpy(dst, src, sizeof(dst));";
		expect(checkCUnsafeFunctions(code, "safe.c")).toEqual([]);
	});

	it("does NOT flag strncat", () => {
		const code = "strncat(buf, input, sizeof(buf) - strlen(buf) - 1);";
		expect(checkCUnsafeFunctions(code, "safe.c")).toEqual([]);
	});

	it("does NOT flag snprintf", () => {
		const code = 'snprintf(buf, sizeof(buf), "%s", name);';
		expect(checkCUnsafeFunctions(code, "safe.c")).toEqual([]);
	});

	it("skips non-C files", () => {
		const code = 'sprintf(buf, "%s", name);';
		expect(checkCUnsafeFunctions(code, "main.py")).toEqual([]);
		expect(checkCUnsafeFunctions(code, "main.ts")).toEqual([]);
	});

	it("skips test files in test directories", () => {
		const code = "strcpy(dst, src);";
		// isTestFile() matches __tests__/ and tests/ directories
		expect(checkCUnsafeFunctions(code, "src/__tests__/helper.c")).toEqual([]);
		expect(checkCUnsafeFunctions(code, "src/tests/test_alloc.c")).toEqual([]);
	});

	it("ignores calls in comments", () => {
		const code = "// strcpy(dst, src);";
		expect(checkCUnsafeFunctions(code, "main.c")).toEqual([]);
	});

	it("works with .cpp files", () => {
		const code = "strcpy(dst, src);";
		const matches = checkCUnsafeFunctions(code, "util.cpp");
		expect(matches.length).toBe(1);
	});

	it("works with .h files", () => {
		const code = "strcpy(dst, src);";
		const matches = checkCUnsafeFunctions(code, "util.h");
		expect(matches.length).toBe(1);
	});
});

// ===========================================
// checkCIncludeGuard
// ===========================================

describe("checkCIncludeGuard", () => {
	it("flags header without guard", () => {
		const code = "#include <stdio.h>\nvoid foo();";
		const matches = checkCIncludeGuard(code, "foo.h");
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(1);
	});

	it("does NOT flag header with #pragma once", () => {
		const code = "#pragma once\nvoid foo();";
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});

	it("does NOT flag header with #ifndef/#define guard", () => {
		const code = "#ifndef FOO_H\n#define FOO_H\nvoid foo();\n#endif";
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});

	it("skips non-header files", () => {
		const code = "#include <stdio.h>\nvoid foo();";
		expect(checkCIncludeGuard(code, "main.c")).toEqual([]);
		expect(checkCIncludeGuard(code, "main.cpp")).toEqual([]);
	});

	it("works with .hpp files", () => {
		const code = "#include <string>\nclass Foo {};";
		const matches = checkCIncludeGuard(code, "foo.hpp");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag with pragma once after whitespace", () => {
		const code = "\n  #pragma once\nvoid foo();";
		expect(checkCIncludeGuard(code, "foo.h")).toEqual([]);
	});
});

// ===========================================
// checkCStrcmpBooleanMisuse
// ===========================================

describe("checkCStrcmpBooleanMisuse", () => {
	it("flags if (strcmp(a, b))", () => {
		const code = 'if (strcmp(name, "admin")) { grant(); }';
		const matches = checkCStrcmpBooleanMisuse(code, "auth.c");
		expect(matches.length).toBe(1);
	});

	it("flags while (strcmp(...))", () => {
		const code = 'while (strcmp(line, "END")) { read_line(); }';
		const matches = checkCStrcmpBooleanMisuse(code, "parser.c");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag if (!strcmp(a, b))", () => {
		const code = 'if (!strcmp(name, "admin")) { grant(); }';
		expect(checkCStrcmpBooleanMisuse(code, "auth.c")).toEqual([]);
	});

	it("does NOT flag if (strcmp(a, b) == 0)", () => {
		const code = 'if (strcmp(name, "admin") == 0) { grant(); }';
		expect(checkCStrcmpBooleanMisuse(code, "auth.c")).toEqual([]);
	});

	it("does NOT flag if (strcmp(a, b) != 0)", () => {
		const code = 'if (strcmp(name, "admin") != 0) { deny(); }';
		expect(checkCStrcmpBooleanMisuse(code, "auth.c")).toEqual([]);
	});

	it("does NOT flag if (strcmp(a, b) < 0)", () => {
		const code = "if (strcmp(a, b) < 0) { swap(); }";
		expect(checkCStrcmpBooleanMisuse(code, "sort.c")).toEqual([]);
	});

	it("also detects strncmp misuse", () => {
		const code = 'if (strncmp(buf, "GET", 3)) { handle(); }';
		const matches = checkCStrcmpBooleanMisuse(code, "http.c");
		expect(matches.length).toBe(1);
	});

	it("skips non-C files", () => {
		const code = "if (strcmp(a, b)) { x(); }";
		expect(checkCStrcmpBooleanMisuse(code, "main.ts")).toEqual([]);
	});

	it("ignores calls in comments", () => {
		const code = "// if (strcmp(a, b)) { x(); }";
		expect(checkCStrcmpBooleanMisuse(code, "main.c")).toEqual([]);
	});
});

// ===========================================
// checkCUncheckedMalloc
// ===========================================

describe("checkCUncheckedMalloc", () => {
	it("flags malloc without null check", () => {
		const code = "int *p = malloc(sizeof(int) * 10);\n*p = 42;";
		const matches = checkCUncheckedMalloc(code, "alloc.c");
		expect(matches.length).toBe(1);
		expect(matches[0].line).toBe(1);
	});

	it("does NOT flag malloc with null check on next line", () => {
		const code = "int *p = malloc(sizeof(int) * 10);\nif (!p) return -1;\n*p = 42;";
		expect(checkCUncheckedMalloc(code, "alloc.c")).toEqual([]);
	});

	it("does NOT flag malloc with NULL comparison", () => {
		const code = "char *buf = malloc(256);\nif (buf == NULL) { return; }\nstrcpy(buf, src);";
		expect(checkCUncheckedMalloc(code, "alloc.c")).toEqual([]);
	});

	it("detects calloc without null check", () => {
		const code = "int *arr = calloc(10, sizeof(int));\narr[0] = 1;";
		const matches = checkCUncheckedMalloc(code, "alloc.c");
		expect(matches.length).toBe(1);
	});

	it("detects realloc without null check", () => {
		const code = "buf = realloc(buf, new_size);\nbuf[0] = 'x';";
		const matches = checkCUncheckedMalloc(code, "alloc.c");
		expect(matches.length).toBe(1);
	});

	it("skips C++ files", () => {
		const code = "int *p = malloc(sizeof(int) * 10);\n*p = 42;";
		expect(checkCUncheckedMalloc(code, "alloc.cpp")).toEqual([]);
	});

	it("skips non-C files", () => {
		const code = "int *p = malloc(sizeof(int) * 10);";
		expect(checkCUncheckedMalloc(code, "alloc.py")).toEqual([]);
	});

	it("does NOT flag with assert check", () => {
		const code = "int *p = malloc(sizeof(int));\nassert(p);\n*p = 1;";
		expect(checkCUncheckedMalloc(code, "alloc.c")).toEqual([]);
	});
});

// ===========================================
// checkCSprintfUsage
// ===========================================

describe("checkCSprintfUsage", () => {
	it("detects sprintf", () => {
		const code = 'sprintf(buf, "%d items", count);';
		const matches = checkCSprintfUsage(code, "fmt.c");
		expect(matches.length).toBe(1);
	});

	it("does NOT flag snprintf", () => {
		const code = 'snprintf(buf, sizeof(buf), "%d items", count);';
		expect(checkCSprintfUsage(code, "fmt.c")).toEqual([]);
	});

	it("skips non-C files", () => {
		const code = 'sprintf(buf, "%s", name);';
		expect(checkCSprintfUsage(code, "main.ts")).toEqual([]);
	});

	it("ignores calls in comments", () => {
		const code = '// sprintf(buf, "%s", name);';
		expect(checkCSprintfUsage(code, "main.c")).toEqual([]);
	});

	it("works with .cpp files", () => {
		const code = 'sprintf(buf, "%s", name);';
		const matches = checkCSprintfUsage(code, "util.cpp");
		expect(matches.length).toBe(1);
	});

	it("ignores calls in strings", () => {
		const code = 'const char *msg = "use sprintf for formatting";';
		expect(checkCSprintfUsage(code, "help.c")).toEqual([]);
	});
});
