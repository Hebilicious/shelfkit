---
description: Write a conventional commit message for the staged changes.
argument-hint: "[scope]"
---

Read the staged diff and write one conventional commit message.

Rules:
- Subject line in the imperative mood, no trailing period, at most 72 characters.
- Type is one of feat, fix, chore, docs, refactor, test, perf, build, ci.
- Include a body only when the change needs a reason that the subject cannot carry.
- Do not mention that the change was generated, and do not list files.
