import { describe, expect, it } from "vitest";
import {
	buildEnvelope,
	extractToolUseIds,
	persistableHeaders,
	splitRequestBody,
} from "./inference-envelope.js";
import type { JsonObject } from "../../lib/json-types.js";

describe("persistableHeaders — positive (must fire)", () => {
	it("joins an array header value into a comma-separated string", () => {
		// kills d7ad7daeb611a6c9 (typeof value === "string" -> true): a mutant
		// that always takes the string branch would return the raw array
		// instead of a joined string.
		const out = persistableHeaders({ "anthropic-version": ["2023-06-01", "extra"] });
		expect(out["anthropic-version"]).toBe("2023-06-01,extra");
		expect(typeof out["anthropic-version"]).toBe("string");
	});

	it("drops a persisted header whose value is neither string nor array", () => {
		// kills 370da12d0811785d (str !== null -> true): a mutant that always
		// assigns str would set the key to null instead of omitting it.
		const out = persistableHeaders({ "anthropic-version": 12345 as unknown as string });
		expect(Object.prototype.hasOwnProperty.call(out, "anthropic-version")).toBe(false);
		expect(out).toEqual({});
	});

	it("still persists a plain string header value", () => {
		const out = persistableHeaders({ "anthropic-beta": "tools-2024-04-04" });
		expect(out["anthropic-beta"]).toBe("tools-2024-04-04");
	});
});

describe("extractToolUseIds — positive and negative (must fire / must not fire)", () => {
	it("skips a null entry in content without throwing, and still finds valid ids", () => {
		// kills 77401de3f5318aaa (block !== null -> true): typeof null is
		// "object", so forcing this check true lets the code read `.type` off
		// null and throw.
		const response: JsonObject = {
			content: [null, { type: "tool_use", id: "abc" }],
		} as unknown as JsonObject;
		expect(() => extractToolUseIds(response)).not.toThrow();
		expect(extractToolUseIds(response)).toEqual(["abc"]);
	});

	it("skips a non-null, non-object block that carries matching type/id fields", () => {
		// kills 7eea8dbd4e2c1856, 1bb1aa4ce0c4fe88, bd3a20fd3cccc016,
		// 12409c7910bf8fdc, 80922fb86bf75ff8, 103823a694ed2f20: a function is
		// not null and not typeof "object", but can still carry own properties
		// named type/id, so any mutant that skips or weakens the
		// null/typeof-object guard will incorrectly include it.
		const fakeBlock = function fakeBlock() {
			/* noop */
		} as unknown as JsonObject;
		(fakeBlock as unknown as { type: string }).type = "tool_use";
		(fakeBlock as unknown as { id: string }).id = "fn-id-1";
		const response: JsonObject = { content: [fakeBlock] } as unknown as JsonObject;
		expect(extractToolUseIds(response)).toEqual([]);
	});

	it("skips a real object block whose type is not tool_use", () => {
		// kills f2364c84b20d7b24 (type === "tool_use" -> true)
		const response: JsonObject = {
			content: [{ type: "text", id: "should-not-be-collected" }],
		} as unknown as JsonObject;
		expect(extractToolUseIds(response)).toEqual([]);
	});

	it("skips a tool_use block whose id is not a string", () => {
		// kills 03ff352edff85a75 (typeof id === "string" -> true)
		const response: JsonObject = {
			content: [{ type: "tool_use", id: 42 }],
		} as unknown as JsonObject;
		expect(extractToolUseIds(response)).toEqual([]);
	});

	it("collects ids only from valid tool_use blocks among mixed content", () => {
		const response: JsonObject = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "tool_use", id: "id-1" },
				{ type: "tool_use", id: "id-2" },
			],
		} as unknown as JsonObject;
		expect(extractToolUseIds(response)).toEqual(["id-1", "id-2"]);
	});
});

describe("buildEnvelope — request field presence (must fire / must not fire)", () => {
	it("omits model/system/tools/messages keys entirely when absent from the body", () => {
		// kills 42d90b8b38928275 (model !== undefined -> true),
		// c5dabca237376f33 (system !== undefined -> true),
		// 1598f5cae6ea06ab (tools !== undefined -> true),
		// b4dad2832ca3e098 (messages !== undefined -> true):
		// any of these mutants forces the assignment even when the source
		// field is undefined, creating an own key with value undefined.
		const env = buildEnvelope({
			requestIndex: 0,
			tsRequest: "2026-01-01T00:00:00.000Z",
			tsResponse: "2026-01-01T00:00:01.000Z",
			requestHeaders: {},
			requestBody: {} as JsonObject,
			response: {} as JsonObject,
		});
		const requestKeys = Object.keys(env.request).sort();
		expect(requestKeys).toEqual(["params"]);
		expect(Object.prototype.hasOwnProperty.call(env.request, "model")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(env.request, "system")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(env.request, "tools")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(env.request, "messages")).toBe(false);
	});

	it("carries model/system/tools/messages through verbatim when present", () => {
		// kills dab37a0722f7dc58 (system !== undefined -> false),
		// 8210b027cd816865 (tools !== undefined -> false),
		// 3f62cfb9397acfea (messages !== undefined -> false),
		// 23ca9dae5eca94e4 (system !== undefined -> === undefined),
		// cfff547f968dc228 (tools !== undefined -> === undefined),
		// a0f0dea8bdc7c2a1 (messages !== undefined -> === undefined):
		// each of these mutants prevents the field from ever being copied
		// into `request` even though the source value is defined.
		const body = {
			model: "claude-x",
			system: "be nice",
			tools: [{ name: "t1" }],
			messages: [{ role: "user", content: "hi" }],
			extra_param: 7,
		} as unknown as JsonObject;
		const env = buildEnvelope({
			requestIndex: 1,
			tsRequest: "2026-01-01T00:00:00.000Z",
			tsResponse: "2026-01-01T00:00:01.000Z",
			requestHeaders: {},
			requestBody: body,
			response: {} as JsonObject,
		});
		expect(env.request.model).toBe("claude-x");
		expect(env.request.system).toBe("be nice");
		expect(env.request.tools).toEqual([{ name: "t1" }]);
		expect(env.request.messages).toEqual([{ role: "user", content: "hi" }]);
		expect((env.request.params as JsonObject).extra_param).toBe(7);
	});

	it("stamps provider as the literal string \"anthropic\"", () => {
		// kills a4b3cf33e44af2b7 ("anthropic" -> "")
		const env = buildEnvelope({
			requestIndex: 0,
			tsRequest: "2026-01-01T00:00:00.000Z",
			tsResponse: "2026-01-01T00:00:01.000Z",
			requestHeaders: {},
			requestBody: {} as JsonObject,
			response: {} as JsonObject,
		});
		expect(env.provider).toBe("anthropic");
		expect(env.provider.length).toBeGreaterThan(0);
	});
});

describe("splitRequestBody sanity", () => {
	it("splits load-bearing fields from params losslessly", () => {
		const body = { model: "m", system: "s", tools: [], messages: [], extra: 1 } as unknown as JsonObject;
		const split = splitRequestBody(body);
		expect(split.model).toBe("m");
		expect(split.system).toBe("s");
		expect(split.params).toEqual({ extra: 1 });
	});
});
