//go:build ignore

package ignore

// @generated supermodel-shard — do not edit
// [deps]
// imports     internal/api/client.go
// imports     internal/cache/cache.go
// imported-by cmd/focus.go
// [calls]
// Run ← init    cmd/focus.go:10
// Run → getGraph    internal/focus/handler.go:342
// extract → reachableImports    internal/focus/handler.go:173
// [impact]
// risk        MEDIUM
// domains     CLIInfrastructure · SupermodelAPI
// direct      1
// transitive  2
// affects     cmd/focus.go
