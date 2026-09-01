import { isJsonObject, type JsonObject } from "../lib/json-types.js";

export function compactJson(value: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) out[key] = item;
	}
	return out;
}

export function asJsonObject(value: unknown): JsonObject | null {
	return isJsonObject(value) ? value : null;
}

export function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function readStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length > 0 ? strings : null;
}
