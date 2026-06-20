/**
 * Assert that a value is present (neither `null` nor `undefined`).
 *
 * This is the harness-compliant replacement for the TypeScript non-null
 * assertion operator (`x!`) — which the non-null-assertion ratchet flags —
 * at sites where an index or lookup is *provably* in-bounds but
 * `noUncheckedIndexedAccess` still widens the type to `T | undefined`:
 *
 * ```ts
 * const first = nonNull(items[0]);   // `items` proven non-empty above
 * const group = nonNull(match[1]);   // regex matched, capture group exists
 * ```
 *
 * Unlike `!`, this is a real runtime guard: if the "impossible" `undefined`
 * ever occurs it throws and surfaces the broken invariant at its source
 * instead of letting `undefined` propagate into a downstream crash. Reach for
 * a proper guard, a `??` default, or an early return instead when absence is a
 * genuine, expected case (e.g. `Map.get`, `Array.find`, parsed input).
 *
 * @typeParam T - The value type, excluding null/undefined.
 * @param value - The value asserted to be present.
 * @param message - Optional context included in the thrown error.
 * @returns `value`, narrowed to `T`.
 * @throws {Error} If `value` is `null` or `undefined`.
 */
export function nonNull<T>(value: T | null | undefined, message?: string): T {
	if (value === null || value === undefined) {
		throw new Error(message ?? "nonNull: expected a value but received null/undefined");
	}
	return value;
}
