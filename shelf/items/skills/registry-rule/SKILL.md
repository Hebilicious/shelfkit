---
name: registry-rule
description: Change what ShelfKit's OpenAPM registry accepts or answers. Use when a registry route, status code, auth decision, or archive check changes.
---

1. Put the rule in `crates/registry`, never in `shelfkit serve` or the Worker: a host does I/O and nothing else.
2. Add a case to `crates/registry/conformance/cases.json` that fails without the rule.
3. Regenerate the case archives with `SHELFKIT_UPDATE_CONFORMANCE=1 cargo test --package shelfkit-registry` and read the diff.
4. Run `moon run registry:test worker:test`: the suite runs against the library, the `shelfkit serve` binary, and the WASM engine.

Keep the wire contract: `tar.gz` as `application/gzip` only, a repeated `PUT` of a version is `409`, a missing or unknown credential is `401`, and `403` is only for a missing scope.
