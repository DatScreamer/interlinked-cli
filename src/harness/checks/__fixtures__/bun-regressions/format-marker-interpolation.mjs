// Bun v1.4 regression #30693: Zig's comptime format string rewrote <r> color
// markers BEFORE arguments were substituted; the Rust port parsed the finished
// string and rewrote marker bytes inside a hyperlink argument (the OSC-8
// terminator ate the trailing marker — "oxfmtr"). General class:
// interpolate-then-parse — data becomes syntax. Our deterministic v1 member
// fires on RegExp built from unescaped interpolation.
// Detector: regex_from_interpolation.
export function markerMatcher(hyperlink) {
	return new RegExp(`<r>${hyperlink}<r>`);
}
