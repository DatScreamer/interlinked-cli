// Bun v1.4 regression #31188: Zig's reinterpretSlice(u16, bytes) truncated a
// trailing odd byte; bytemuck::cast_slice PANICS on it — Blob.text() on a
// UTF-16 BOM + odd byte count crashed the process. The fix was
// `&buf[..buf.len() & !1]`. Detector: ubs_rust_unchecked_cast_slice.
fn utf16_view(buf: &[u8]) -> &[u16] {
    bytemuck::cast_slice(buf)
}
