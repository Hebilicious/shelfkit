---
name: update-goldens
description: Regenerate the compiler's golden files after a deliberate change to what `shelfkit compile` writes. Use when a compiler golden test fails because the output changed on purpose.
---

1. Confirm the change is deliberate: a golden test that fails without a compiler change usually means APM's shape moved.
2. Run `SHELFKIT_UPDATE_GOLDEN=1 cargo test --package shelfkit-compiler`.
3. Read every changed golden file. Each difference must follow from your change; anything else is a bug.
4. Run `moon run engine:test`: the WASM engine must print `shelfkit compile --dry-run --json` byte for byte.
