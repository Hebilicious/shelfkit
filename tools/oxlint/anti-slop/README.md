# Vendored anti-slop rules

Vendored from `dmmulroy/anti-slop` at commit `c44ef22`, under the MIT license in `LICENSE`, by way of [heb-stack](https://github.com/Hebilicious/heb-stack)'s `tools/oxlint/anti-slop`, whose local edits it keeps. `vendor/eslint-stylistic/` is ESLint Stylistic code that upstream vendors in turn; its own `UPSTREAM.md` and `LICENSE` sit beside it.

ShelfKit takes the generic core only. heb-stack's `effect/` plugin and its `anti-slop-effect/*` rules are left out, because ShelfKit does not use Effect or XState.

This repository receives storage, network, Worker, URL, and imported-file data as `unknown` and validates it at explicit boundaries with Valibot. The rules therefore accept documented `BOUNDARY:` exceptions for those contracts through the `allowWithBoundaryComment` option, which `shared/boundary-comment.ts` implements once. `no-known-value-widening` accepts the exception on the type guard itself. `typeof` is permitted inside type guards. Necessary assertions require an adjacent, evidence-bearing `SAFETY:` comment.

`no-module-level-mutable-state` keeps Worker and library modules free of module-level `let` and `var`, which every request an isolate serves would share. Browser presentation, tooling, and configuration files are exempt in `oxlint.config.ts`.

Some rules are registered but not enabled in `oxlint.config.ts`, which gives the reason for each beside the setting.

## Taking upstream changes

heb-stack's local edits are the `BOUNDARY:` options, `no-wall-clock-budget`, `no-module-level-mutable-state`, and three semantic changes: `no-runtime-typeof` exempts closures nested anywhere inside a type guard, `no-unknown-parameters` with `allowInTypeGuards` skips every parameter of a type guard, and `shared/lexical-type-parameters.ts` reads only own properties. Take a newer version from heb-stack rather than from upstream, so those edits come with it, and copy every file it adds, license and provenance files included.
