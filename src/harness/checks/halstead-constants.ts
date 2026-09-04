// Shared Halstead reporting floors. TS (compiler API) and Go (go/ast policy
// from luisantonioig/halstead-metrics) use the SAME bars so a difficulty of
// 80 means the same thing in both languages.

/** Difficulty above this fires. Calibrated on the TS corpus (p99.9 ≈ 85). */
export const HALSTEAD_DIFFICULTY_CEILING = 80;

/** Minimum volume before difficulty is considered (skips tiny functions). */
export const HALSTEAD_VOLUME_FLOOR = 200;

/** Source-length floor for the TS token walk only (performance). */
export const MIN_TEXT_FOR_TALLY = 200;
