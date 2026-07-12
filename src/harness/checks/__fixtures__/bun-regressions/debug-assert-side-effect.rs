// Bun v1.4 regression #30678 (docs/external-pulse/bun-in-rust.md):
// Zig's assert is a function (argument always runs); Rust's debug_assert! is
// a macro erased in release builds — insert_stale stopped running and HMR
// broke for React HTML routes. Detector: ubs_rust_debug_assert_side_effect.
struct Dev {
    client_graph: Graph,
    import_source: String,
}

fn refresh(dev: &mut Dev, react_refresh_index: usize) -> Result<(), Error> {
    debug_assert!(dev.client_graph.insert_stale(&dev.import_source, false)? == react_refresh_index);
    Ok(())
}
