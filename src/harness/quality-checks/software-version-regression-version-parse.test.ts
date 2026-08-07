import { describe, expect, it } from "vitest";
import {
	classifyGenericKind,
	isVersionRegression,
	looksComparable,
	looksLikeModelIdentifier,
	modelFamilyOf,
	modelProviderOf,
	providerDisplayName,
} from "./software-version-regression-version-parse.js";

describe("looksLikeModelIdentifier", () => {
	it("returns true for a real model identifier shape", () => {
		expect(looksLikeModelIdentifier("claude-test-4-7")).toBe(true);
	});

	it("returns false when there is no match at all", () => {
		expect(looksLikeModelIdentifier("just some plain text")).toBe(false);
	});

	it("returns false when the provider word is followed by a non-model file extension", () => {
		expect(looksLikeModelIdentifier("see CLAUDE.md for details")).toBe(false);
	});

	it("returns false when the matched model token itself ends in a non-model extension", () => {
		expect(looksLikeModelIdentifier("see claude-3.5.json for details")).toBe(false);
	});
});

describe("classifyGenericKind", () => {
	it("classifies as model when the key mentions model", () => {
		expect(classifyGenericKind("modelName", "whatever")).toBe("model");
	});

	it("classifies as model when the value looks like a model identifier (key does not mention model)", () => {
		expect(classifyGenericKind("value", "claude-test-4-7")).toBe("model");
	});

	it("classifies as api_version when the key mentions api version", () => {
		expect(classifyGenericKind("apiVersion", "not-a-date")).toBe("api_version");
	});

	it("classifies as api_version when the value parses as a date version (key does not match)", () => {
		expect(classifyGenericKind("field", "2024-06-15")).toBe("api_version");
	});

	it("classifies as generic when neither key nor value match anything", () => {
		expect(classifyGenericKind("field", "hello world")).toBe("generic");
	});
});

describe("isVersionRegression", () => {
	it("returns false when either side fails to parse comparably", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "not-a-version-at-all!!", kind: "generic", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "1.2.3", kind: "generic", line: 1, text: "a" },
			),
		).toBe(false);
	});

	it("returns false when the two sides parse to different comparable kinds", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "2024-06-15", kind: "generic", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "1.2.3", kind: "generic", line: 1, text: "a" },
			),
		).toBe(false);
	});

	it("returns true when the numeric version decreases", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "2.0.0", kind: "generic", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "1.0.0", kind: "generic", line: 1, text: "a" },
			),
		).toBe(true);
	});

	it("returns false when the numeric version increases", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "1.0.0", kind: "generic", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "2.0.0", kind: "generic", line: 1, text: "a" },
			),
		).toBe(false);
	});

	it("flags a model regression when the after version is numerically lower (kind is model)", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "claude-test-4-7", kind: "model", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "claude-test-4-5", kind: "model", line: 1, text: "a" },
			),
		).toBe(true);
	});

	it("returns false when the model version increases", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "claude-test-4-5", kind: "model", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "claude-test-4-7", kind: "model", line: 1, text: "a" },
			),
		).toBe(false);
	});

	it("falls back to the named-model parser when the numeric model path finds no digits after the provider token", () => {
		// "claude" matches MODEL_PROVIDER_RE, but the digit sits BEFORE the
		// provider token so the tail-slice in parseModelVersion is empty and
		// it returns undefined; parseNamedModelVersion must supply the parts
		// by scanning the whole raw string instead.
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "4-claude", kind: "model", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "3-claude", kind: "model", line: 1, text: "a" },
			),
		).toBe(true);
	});

	it("returns false (not a regression) when both sides parse to equal comparable parts", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "1.2.3", kind: "generic", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "1.2.3", kind: "generic", line: 1, text: "a" },
			),
		).toBe(false);
	});

	it("returns false when the model provider matches but no digits exist anywhere in the raw string", () => {
		// "claude" matches MODEL_PROVIDER_RE but has no digits at all, so both
		// parseModelVersion and parseNamedModelVersion return undefined inside
		// comparableVersion, which then falls through to parseNumericVersion
		// (also undefined for "claude") and returns undefined overall.
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "claude", kind: "model", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "1.2.3", kind: "generic", line: 1, text: "a" },
			),
		).toBe(false);
	});

	it("treats single-major-number versions as comparable via the numeric fallback", () => {
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "5", kind: "generic", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "4", kind: "generic", line: 1, text: "a" },
			),
		).toBe(true);
	});

	it("returns true when the after model version has fewer parts than before, padding missing after-parts with 0", () => {
		// before "claude-1-2-3-4" -> [1,2,3,4]; after "claude-1-2" -> [1,2].
		// compareParts pads the missing after-indices with 0, so it reads as a
		// decrease at index 2 (3 -> 0).
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "claude-1-2-3-4", kind: "model", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "claude-1-2", kind: "model", line: 1, text: "a" },
			),
		).toBe(true);
	});

	it("returns false when the after model version has more parts than before, padding missing before-parts with 0", () => {
		// before "claude-1-2" -> [1,2]; after "claude-1-2-3-4" -> [1,2,3,4].
		// compareParts pads the missing before-indices with 0, so index 2 reads
		// as an increase (0 -> 3), not a regression.
		expect(
			isVersionRegression(
				{ anchor: "a", label: "a", version: "claude-1-2", kind: "model", line: 1, text: "a" },
				{ anchor: "a", label: "a", version: "claude-1-2-3-4", kind: "model", line: 1, text: "a" },
			),
		).toBe(false);
	});
});

describe("looksComparable", () => {
	it("returns true for a date-shaped value", () => {
		expect(looksComparable("2024-06-15")).toBe(true);
	});

	it("returns true for a named model version when kind is model", () => {
		expect(looksComparable("gemini-v2", "model")).toBe(true);
	});

	it("returns true for a provider+numeric model version regardless of kind", () => {
		expect(looksComparable("claude-test-4-7")).toBe(true);
	});

	it("returns true for a plain numeric version", () => {
		expect(looksComparable("1.2.3")).toBe(true);
	});

	it("returns false for a value that matches none of the parsers", () => {
		expect(looksComparable("latest")).toBe(false);
	});

	it("returns false for an empty-ish non-comparable string with default generic kind", () => {
		expect(looksComparable("workspace:*")).toBe(false);
	});

	it("returns false when kind is model but the value contains no digits at all", () => {
		// parseNamedModelVersion's regex requires at least one digit; with none
		// present its match list is empty and it returns undefined, so this
		// exercises that branch directly (kind === "model" is true, but the
		// parser itself still yields nothing).
		expect(looksComparable("claude", "model")).toBe(false);
	});
});

describe("modelProviderOf / modelFamilyOf", () => {
	it("extracts the provider token from a model string", () => {
		expect(modelProviderOf("claude-test-4-7")).toBe("claude");
	});

	it("returns undefined when no provider token is present", () => {
		expect(modelProviderOf("no-provider-here")).toBeUndefined();
	});

	it("returns the provider directly when modelFamilyOf finds one", () => {
		expect(modelFamilyOf("claude-test-4-7")).toBe("claude");
	});

	it("derives a family name by stripping trailing version digits when no provider matches", () => {
		expect(modelFamilyOf("widget-9-1")).toBe("widget");
	});

	it("returns undefined when stripping leaves nothing", () => {
		expect(modelFamilyOf("4-7")).toBeUndefined();
	});
});

describe("providerDisplayName", () => {
	it("maps gpt to OpenAI", () => {
		expect(providerDisplayName("gpt")).toBe("OpenAI");
	});

	it("maps o to OpenAI", () => {
		expect(providerDisplayName("o")).toBe("OpenAI");
	});

	it("maps claude to Anthropic", () => {
		expect(providerDisplayName("claude")).toBe("Anthropic");
	});

	it("maps gemini to Google Gemini", () => {
		expect(providerDisplayName("gemini")).toBe("Google Gemini");
	});

	it("maps llama to Meta Llama", () => {
		expect(providerDisplayName("llama")).toBe("Meta Llama");
	});

	it("maps mistral to Mistral", () => {
		expect(providerDisplayName("mistral")).toBe("Mistral");
	});

	it("maps mixtral to Mistral", () => {
		expect(providerDisplayName("mixtral")).toBe("Mistral");
	});

	it("maps qwen to Qwen", () => {
		expect(providerDisplayName("qwen")).toBe("Qwen");
	});

	it("maps deepseek to DeepSeek", () => {
		expect(providerDisplayName("deepseek")).toBe("DeepSeek");
	});

	it("maps command-r to Cohere", () => {
		expect(providerDisplayName("command-r")).toBe("Cohere");
	});

	it("maps nova to Amazon Nova", () => {
		expect(providerDisplayName("nova")).toBe("Amazon Nova");
	});

	it("returns undefined for an unknown provider", () => {
		expect(providerDisplayName("unknown-provider")).toBeUndefined();
	});

	it("returns undefined when provider is undefined", () => {
		expect(providerDisplayName(undefined)).toBeUndefined();
	});
});
