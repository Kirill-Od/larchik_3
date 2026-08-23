---
name: code-review
description: Audit a change on two axes — standards compliance and specification compliance — and report findings under fixed headers. Use as the quality gate after each implemented task, before moving on to the next one.
---

# Code Review (two-axis audit)

Review the change, not the whole codebase. Start from the diff (`git diff`, or the set of files the developer reported changing when there is no commit yet).

You audit. You do **not** fix — findings go back to the developer.

## Axis 1 — Standards

- **Correctness.** Trace the actual logic. Off-by-one, wrong operator, unhandled null, a branch that can never be taken, a resource never released. For each: what input produces what wrong output?
- **Security.** For anything guarding a boundary, attack it. Enumerate the bypasses and check each against the code — do not accept "there is a validator" as evidence that the validator is sufficient.
- **Error handling.** Are failures caught at a level that can act on them? Do messages reaching the user leak internals — stack traces, absolute paths, driver internals?
- **Simplicity.** Duplication that should be extracted, abstraction with one caller, dead code, a helper that restates the standard library.
- **Tests.** Does each new behavior have a test that would fail without the change? Are the adversarial cases present, not just the happy path? Is any test asserting private internals?
- **Fit.** Naming, structure, and idiom consistent with the surrounding code.

## Axis 2 — Spec

- Every requirement the task claims to deliver, checked against what the code actually does.
- Requirements silently dropped, narrowed, or reinterpreted.
- Behavior added that no requirement asked for.
- Where the spec and reality disagree (missing data, contradictory schema), is the disagreement handled honestly, or papered over with an invented answer?

## Verifying before reporting

Before writing a finding, try to refute it. Re-read the surrounding lines; check whether a guard elsewhere already covers it. **Run the code where running it settles the question** — an executed counterexample beats an argued one. Drop what you cannot substantiate; a confident wrong finding costs the loop a full cycle.

## Output format

Exactly two headers, most severe first within each. Every finding carries `file:line`, one sentence naming the defect, and a concrete failure scenario (input → wrong result).

```markdown
## Standards
- `src/foo.js:42` — <defect>. <input → wrong result>.

## Spec
- `src/bar.js:17` — <requirement> is not met. <what the code does instead>.
```

Under a header with nothing to report, write `- None.` Do not pad the report to look thorough: **zero findings is a valid and useful result**, and inventing a nitpick to avoid an empty report actively damages the loop.
