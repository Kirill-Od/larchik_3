---
name: tdd
description: Drive implementation through test-first RED-GREEN-REFACTOR loops at public boundaries. Use whenever writing or changing behavior that can be asserted, so that every line of production code is justified by a test that failed first.
---

# Test-Driven Development

## The loop

**RED.** Write one test that asserts the behavior you are about to add. Run it. **Watch it fail, and read the failure message.** A test that passes before the code exists is testing nothing; a test that fails for the wrong reason (import error, typo) is not yet RED.

**GREEN.** Write the least code that makes it pass. Not the general solution — the one that satisfies this assertion. Run the whole suite, not just the new test.

**REFACTOR.** With the suite green, improve the shape: extract duplication, rename, simplify. Run the suite again after each change. No new behavior enters here.

Then repeat. Never carry two failing tests at once.

## Test at the public boundary

Assert through the interface a caller actually uses — the exported function, the tool handler, the CLI entry point. Tests bound to private helpers ossify the implementation and have to be rewritten during every refactor, which defeats the point.

A useful check: *if I rewrote the internals completely but kept the behavior, would this test still pass?* If no, it is testing the wrong layer.

## What earns a test

- The happy path, once per distinct behavior.
- Each boundary: empty input, one element, the limit, one past the limit.
- Each error path the code explicitly handles — assert the *shape* of the error the caller sees.
- Every security or safety rule, expressed adversarially: not "a SELECT is allowed" but "an INSERT is refused", "two statements separated by a semicolon are refused", "a comment before the verb does not smuggle a write through".
- Every bug found during review, as a regression test written *before* the fix.

## What does not earn a test

Configuration constants, pure re-exports, and third-party library behavior. Test your use of a library, not the library.

## Verifying a test actually guards something

A passing test is not evidence. The test that matters is the one that **fails when the
thing it protects is removed**, so prove that: revert the protection in a scratch copy,
run the test, watch it go red, restore. Three failure modes recur, and all three look
identical from the outside — a green suite:

- **The assertion is rescued by something other than the mechanism.** An alternation whose
  most generic member matches unrelated prose (`/narrow|aggregate|WHERE|LIMIT/` still
  matches a message stripped of every concrete instruction); a value the pristine code
  happens to produce by a second route. For each assertion ask: *which other code path
  could also satisfy this?*
- **The fixture never reaches the branch.** The assertion is correct and the code is
  correct, but the input is too small, too clean, or too short to enter the guarded path.
  Assert the precondition explicitly — `assert.ok(payload.length > BUDGET)` — so the test
  cannot silently stop exercising what it names.
- **The revert did not apply.** A botched escape, a stale copy, an edit to the wrong file.
  Put an assertion inside the revert itself confirming the swap landed, and revert **one
  protection at a time** rather than in a batch, or a no-op revert reads as proof.
- **The scratch copy is under-staged.** Copying only the source and test directories leaves
  out repo-root files a test legitimately reads, so *every* revert shows the same unrelated
  failure and the signal is lost in it. Stage what the suite actually reads, and treat a
  failure common to every revert as a harness bug rather than a finding.

## Rules

- Do not write production code with no failing test demanding it.
- Do not weaken a test to make it pass. If the assertion was wrong, say so explicitly and fix the assertion as its own deliberate step.
- Do not delete or skip a red test to move on. A red test is information.
- Keep tests independent: no shared mutable state, no ordering dependency, no leftover files between runs.
