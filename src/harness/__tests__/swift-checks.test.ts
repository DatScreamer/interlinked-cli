import { describe, expect, it } from "vitest";
import {
	checkFunctionComplexity,
	checkJsonInLoop,
	checkQueryInLoop,
	checkRegexInLoop,
	checkSortInLoop,
	checkSwiftAbbreviations,
	checkSwiftDelegateNotWeak,
	checkSwiftFileIdOverFilePath,
	checkSwiftFilterCount,
	checkSwiftForceCast,
	checkSwiftForceTry,
	checkSwiftForceUnwrap,
	checkSwiftGlobalVarNoIsolation,
	checkSwiftImplicitlyUnwrappedOptional,
	checkSwiftLegacyHashValue,
	checkSwiftLegacyRandom,
	checkSwiftSelfInEscapingClosure,
	checkSwiftTaskDetached,
	checkSwiftUnhandledTaskError,
} from "../generic-checks.js";

// ===========================================
// Apple API Design Guidelines — Safety Checks
// ===========================================

describe("checkSwiftForceCast", () => {
	it("detects force cast (as!)", () => {
		const code = "let x = someValue as! String";
		const matches = checkSwiftForceCast(code, "Model.swift");
		expect(matches.length).toBe(1);
	});

	it("ignores conditional cast (as?)", () => {
		const code = "let x = someValue as? String";
		expect(checkSwiftForceCast(code, "Model.swift")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "let x = someValue as! String";
		expect(checkSwiftForceCast(code, "ModelTests.swift")).toEqual([]);
	});

	it("returns empty for non-Swift files", () => {
		const code = "let x = someValue as! String";
		expect(checkSwiftForceCast(code, "file.ts")).toEqual([]);
	});
});

describe("checkSwiftForceTry", () => {
	it("detects force try (try!)", () => {
		const code = "let data = try! JSONDecoder().decode(Model.self, from: json)";
		const matches = checkSwiftForceTry(code, "Parser.swift");
		expect(matches.length).toBe(1);
	});

	it("ignores try? (optional try)", () => {
		const code = "let data = try? JSONDecoder().decode(Model.self, from: json)";
		expect(checkSwiftForceTry(code, "Parser.swift")).toEqual([]);
	});

	it("ignores plain try", () => {
		const code = "let data = try JSONDecoder().decode(Model.self, from: json)";
		expect(checkSwiftForceTry(code, "Parser.swift")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "let data = try! decode()";
		expect(checkSwiftForceTry(code, "tests/ParserTests.swift")).toEqual([]);
	});
});

describe("checkSwiftForceUnwrap", () => {
	it("detects force unwrap on optional", () => {
		const code = "let name = user.name!";
		const matches = checkSwiftForceUnwrap(code, "ViewModel.swift");
		expect(matches.length).toBe(1);
	});

	it("skips @IBOutlet lines", () => {
		const code = "@IBOutlet weak var label: UILabel!";
		expect(checkSwiftForceUnwrap(code, "ViewController.swift")).toEqual([]);
	});

	it("ignores != operator", () => {
		const code = 'if a != b { print("different") }';
		expect(checkSwiftForceUnwrap(code, "Logic.swift")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "let value = optional!";
		expect(checkSwiftForceUnwrap(code, "test_logic.swift")).toEqual([]);
	});
});

describe("checkSwiftImplicitlyUnwrappedOptional", () => {
	it("detects implicitly unwrapped optional", () => {
		const code = "var name: String!";
		const matches = checkSwiftImplicitlyUnwrappedOptional(code, "Model.swift");
		expect(matches.length).toBe(1);
	});

	it("skips @IBOutlet declarations", () => {
		const code = "@IBOutlet weak var button: UIButton!";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "ViewController.swift")).toEqual([]);
	});

	it("ignores regular optionals", () => {
		const code = "var name: String?";
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Model.swift")).toEqual([]);
	});

	it("ignores non-optional types", () => {
		const code = 'var name: String = "hello"';
		expect(checkSwiftImplicitlyUnwrappedOptional(code, "Model.swift")).toEqual([]);
	});
});

// ===========================================
// Memory Safety
// ===========================================

describe("checkSwiftDelegateNotWeak", () => {
	it("detects non-weak delegate", () => {
		const code = "var delegate: MyDelegate?";
		const matches = checkSwiftDelegateNotWeak(code, "Component.swift");
		expect(matches.length).toBe(1);
	});

	it("allows weak delegate", () => {
		const code = "weak var delegate: MyDelegate?";
		expect(checkSwiftDelegateNotWeak(code, "Component.swift")).toEqual([]);
	});

	it("detects non-weak custom delegate name", () => {
		const code = "var dataSourceDelegate: TableDelegate?";
		const matches = checkSwiftDelegateNotWeak(code, "Table.swift");
		expect(matches.length).toBe(1);
	});
});

// ===========================================
// Legacy API Detection
// ===========================================

describe("checkSwiftLegacyRandom", () => {
	it("detects arc4random usage", () => {
		const code = "let n = arc4random_uniform(10)";
		const matches = checkSwiftLegacyRandom(code, "Utils.swift");
		expect(matches.length).toBe(1);
	});

	it("ignores modern random API", () => {
		const code = "let n = Int.random(in: 0..<10)";
		expect(checkSwiftLegacyRandom(code, "Utils.swift")).toEqual([]);
	});
});

describe("checkSwiftLegacyHashValue", () => {
	it("detects legacy hashValue property", () => {
		const code = "var hashValue: Int {\n    return id.hashValue\n}";
		const matches = checkSwiftLegacyHashValue(code, "Model.swift");
		expect(matches.length).toBe(1);
	});

	it("ignores hash(into:) implementation", () => {
		const code = "func hash(into hasher: inout Hasher) {\n    hasher.combine(id)\n}";
		expect(checkSwiftLegacyHashValue(code, "Model.swift")).toEqual([]);
	});
});

describe("checkSwiftFileIdOverFilePath", () => {
	it("detects #file usage", () => {
		const code = 'print("Error in \\(#file)")';
		const matches = checkSwiftFileIdOverFilePath(code, "Logger.swift");
		expect(matches.length).toBe(1);
	});

	it("detects #filePath usage", () => {
		const code = "log(path: #filePath)";
		const matches = checkSwiftFileIdOverFilePath(code, "Logger.swift");
		expect(matches.length).toBe(1);
	});

	it("ignores #fileID", () => {
		const code = "log(id: #fileID)";
		expect(checkSwiftFileIdOverFilePath(code, "Logger.swift")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "print(#file)";
		expect(checkSwiftFileIdOverFilePath(code, "LoggerTests.swift")).toEqual([]);
	});
});

describe("checkSwiftAbbreviations", () => {
	it("detects abbreviated variable names", () => {
		const code = "var btnSubmit: UIButton";
		const matches = checkSwiftAbbreviations(code, "View.swift");
		expect(matches.length).toBe(1);
	});

	it("detects abbreviated function parameters", () => {
		const code = "func configure(lbl: UILabel) {}";
		const matches = checkSwiftAbbreviations(code, "View.swift");
		expect(matches.length).toBe(1);
	});

	it("allows full names", () => {
		const code = "var submitButton: UIButton";
		expect(checkSwiftAbbreviations(code, "View.swift")).toEqual([]);
	});
});

// ===========================================
// Concurrency Safety (SE-0302, SE-0306, SE-0337)
// ===========================================

describe("checkSwiftTaskDetached", () => {
	it("detects Task.detached usage", () => {
		const code = "Task.detached {\n    await process()\n}";
		const matches = checkSwiftTaskDetached(code, "Worker.swift");
		expect(matches.length).toBe(1);
	});

	it("allows regular Task usage", () => {
		const code = "Task {\n    await process()\n}";
		expect(checkSwiftTaskDetached(code, "Worker.swift")).toEqual([]);
	});
});

describe("checkSwiftUnhandledTaskError", () => {
	it("detects try without do/catch inside Task", () => {
		const code = "Task {\n    let data = try await fetchData()\n    process(data)\n}";
		const matches = checkSwiftUnhandledTaskError(code, "Service.swift");
		expect(matches.length).toBe(1);
	});

	it("allows try? inside Task (error handled)", () => {
		const code = "Task {\n    let data = try? await fetchData()\n}";
		expect(checkSwiftUnhandledTaskError(code, "Service.swift")).toEqual([]);
	});

	it("allows do/catch inside Task", () => {
		const code =
			"Task {\n    do {\n        let data = try await fetchData()\n    } catch {\n        print(error)\n    }\n}";
		expect(checkSwiftUnhandledTaskError(code, "Service.swift")).toEqual([]);
	});
});

describe("checkSwiftGlobalVarNoIsolation", () => {
	it("detects global mutable var without isolation", () => {
		const code = "var sharedState = [String]()\n\nclass MyClass {}";
		const matches = checkSwiftGlobalVarNoIsolation(code, "Globals.swift");
		expect(matches.length).toBe(1);
	});

	it("allows global let (immutable)", () => {
		const code = 'let constant = "hello"';
		expect(checkSwiftGlobalVarNoIsolation(code, "Constants.swift")).toEqual([]);
	});

	it("allows @MainActor annotated var", () => {
		const code = "@MainActor var sharedState = [String]()";
		expect(checkSwiftGlobalVarNoIsolation(code, "Globals.swift")).toEqual([]);
	});

	it("ignores vars inside class/struct bodies", () => {
		const code = 'class Foo {\n    var name: String = ""\n}';
		expect(checkSwiftGlobalVarNoIsolation(code, "Foo.swift")).toEqual([]);
	});
});

describe("checkSwiftSelfInEscapingClosure", () => {
	it("detects self usage in @escaping closure without capture list", () => {
		const code =
			"func setup(completion: @escaping () -> Void) {\n    doWork {\n        self.update()\n    }\n}";
		const matches = checkSwiftSelfInEscapingClosure(code, "ViewModel.swift");
		expect(matches.length).toBe(1);
	});

	it("allows [weak self] capture list", () => {
		const code =
			"func setup(completion: @escaping () -> Void) {\n    doWork { [weak self] in\n        self?.update()\n    }\n}";
		expect(checkSwiftSelfInEscapingClosure(code, "ViewModel.swift")).toEqual([]);
	});
});

// ===========================================
// Performance Checks
// ===========================================

describe("checkSwiftFilterCount", () => {
	it("detects .filter { }.count pattern", () => {
		const code = "let count = items.filter { $0.isActive }.count";
		const matches = checkSwiftFilterCount(code, "Query.swift");
		expect(matches.length).toBe(1);
	});

	it("allows .count(where:)", () => {
		const code = "let count = items.count(where: { $0.isActive })";
		expect(checkSwiftFilterCount(code, "Query.swift")).toEqual([]);
	});
});

describe("Swift checks in multi-language perf functions", () => {
	it("checkSortInLoop detects .sorted() in Swift loop", () => {
		const code = "for item in items {\n    let sorted = data.sorted()\n    process(sorted)\n}";
		const matches = checkSortInLoop(code, "Processor.swift");
		expect(matches.length).toBe(1);
	});

	it("checkJsonInLoop detects JSONDecoder in Swift loop", () => {
		const code =
			"for data in chunks {\n    let obj = try JSONDecoder().decode(Model.self, from: data)\n}";
		const matches = checkJsonInLoop(code, "Parser.swift");
		expect(matches.length).toBe(1);
	});

	it("checkRegexInLoop detects NSRegularExpression in Swift loop", () => {
		const code =
			'for line in lines {\n    let regex = try NSRegularExpression(pattern: "\\\\d+")\n    let matches = regex.matches(in: line, range: range)\n}';
		const matches = checkRegexInLoop(code, "Parser.swift");
		expect(matches.length).toBe(1);
	});

	it("checkQueryInLoop detects Core Data fetch in Swift loop", () => {
		const code =
			"for id in ids {\n    let result = try context.fetch(request)\n    process(result)\n}";
		const matches = checkQueryInLoop(code, "DataStore.swift");
		expect(matches.length).toBe(1);
	});

	it("checkFunctionComplexity works on Swift files", () => {
		const code =
			"func complex(a: Int, b: Int, c: Int, d: Int, e: Int, f: Int, g: Int) {\n    print(a)\n}";
		const matches = checkFunctionComplexity(code, "Complex.swift");
		expect(matches.length).toBeGreaterThan(0);
	});
});

// ===========================================
// Non-Swift files return empty
// ===========================================

describe("Swift checks skip non-Swift files", () => {
	const swiftCode = "let x = value as! String\ntry! decode()\nvar delegate: MyDelegate?";

	it("checkSwiftForceCast skips .ts", () => {
		expect(checkSwiftForceCast(swiftCode, "file.ts")).toEqual([]);
	});

	it("checkSwiftForceTry skips .py", () => {
		expect(checkSwiftForceTry(swiftCode, "file.py")).toEqual([]);
	});

	it("checkSwiftDelegateNotWeak skips .go", () => {
		expect(checkSwiftDelegateNotWeak(swiftCode, "file.go")).toEqual([]);
	});

	it("checkSwiftTaskDetached skips .rs", () => {
		expect(checkSwiftTaskDetached(swiftCode, "file.rs")).toEqual([]);
	});
});
