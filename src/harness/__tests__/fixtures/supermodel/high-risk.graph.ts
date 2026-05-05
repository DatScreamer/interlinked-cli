// @generated supermodel-shard — do not edit
// [deps]
// imports     src/lib/util.ts
// imports     src/lib/db.ts
// imported-by src/api/users.ts
// imported-by src/api/posts.ts
// imported-by src/api/comments.ts
// [calls]
// process ← handle    src/api/users.ts:42
// process ← handle    src/api/posts.ts:51
// process → fetchData    src/lib/db.ts:18
// [impact]
// risk        HIGH
// domains     API · Database · Auth · Notifications
// direct      8
// transitive  50
// affects     src/api/users.ts · src/api/posts.ts · src/api/comments.ts · src/api/admin.ts · src/api/auth.ts · src/api/billing.ts · src/api/profile.ts · src/api/settings.ts
