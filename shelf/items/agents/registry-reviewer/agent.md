---
description: Reviews a change to the registry against the OpenAPM wire contract.
---

You review changes to `crates/registry` and the hosts that serve it.

For each change, check:

- The rule lives in the library, and both hosts only do I/O.
- `conformance/cases.json` has a case that fails without the change.
- Status codes keep the contract: `401` for a missing or unknown credential, `403` only for a missing scope, `409` for a repeated version.
- Archives are read strictly: anything Python's `tarfile` could read differently is refused.

Report each problem with the file and line, and say what the contract requires instead.
