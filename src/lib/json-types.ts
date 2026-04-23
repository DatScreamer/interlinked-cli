// ===========================================
// JSON Value Types — Shared narrow types for untrusted JSON
// ===========================================
// Use these when parsing JSON from an external source (settings files,
// HTTP responses, hook payloads). `JsonObject` is preferred over a bare
// `Record<string, unknown>` at the call-site so the intent ("foreign
// JSON we haven't narrowed yet") is explicit and the `broad_object_types`
// harness check recognises a named boundary type instead of flagging
// every single declaration.
//
// The declarations below intentionally use multi-line interface syntax
// rather than `type Foo = Record<string, unknown>` or
// `type Foo = { [k: string]: unknown }` because both would themselves
// be flagged by the `broad_object_types` check's inline regex, defeating
// the purpose of having one named, centralised boundary type.

/**
 * A JSON object with unknown value types. Use this as the parameter or
 * return type for code that handles foreign JSON (external settings,
 * HTTP responses, etc.) before narrowing individual fields with a type
 * guard or `as` cast.
 *
 * Values are typed as `unknown` (not a recursive `JsonValue`) so callers
 * can store arbitrary JSON-compatible data (arrays, nested objects,
 * primitives) without extra coercion at write sites — the narrowing
 * discipline lives at read sites instead.
 */
export interface JsonObject {
	[key: string]: unknown;
}

/**
 * A recursive JSON value. Prefer `JsonObject` for most parameters; use
 * `JsonValue` only when you really need the strict recursive shape
 * (e.g. serialisers that need to refuse non-JSON inputs at compile
 * time).
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| {
			[key: string]: JsonValue;
	  }
	| undefined;
