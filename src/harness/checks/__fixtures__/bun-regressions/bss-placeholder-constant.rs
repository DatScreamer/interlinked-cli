// Bun v1.4 regression #31503, constant VERBATIM from the post: the comment
// confessed the value was a stand-in; nothing read the comment. It lowered an
// interning ceiling from 8.4M to 270,272 and made a ptrs[4095] off-by-one
// reachable — Rust's kept bounds checks panicked where ReleaseFast Zig wrote
// past the end. Detector: placeholder_runtime_constant.

/// ... so use a nonzero stand-in until Phase B threads the
/// per-instantiation value through.
pub const BSS_OVERFLOW_BLOCK_SIZE: usize = 64;
