---
name: incremental-implementation
description: Implement one planned task at a time as a vertical slice, under strict simplicity constraints, verifying execution after each step. Use during the development phase of a feature to keep changes small, working, and justified.
---

# Incremental Implementation

Implement exactly **one** task from `tasks/todo.md` per invocation. Do not read ahead and build for tasks that are still unchecked.

## Order of work

1. Read the task, its deliverable, and its named test.
2. Read the code the task touches — actually read it, do not infer the shape from filenames.
3. Follow [tdd](../tdd/SKILL.md): write the failing test first.
4. Implement the minimum that passes.
5. **Run it.** The test suite, and where the task delivers a runnable surface, the program itself. A task is not done because the code looks right.
6. Mark the task `[x]` in `tasks/todo.md`.
7. Report: what changed, what was run, and the actual output.

## Simplicity constraints

- **Build for today's task.** No configuration hooks, no plugin points, no abstraction that has exactly one implementation. Generality is added when the second case arrives, not in anticipation of it.
- **Prefer deleting to adding.** If existing code nearly does the job, change it rather than growing a parallel path beside it.
- **No speculative error handling.** Handle failures that can actually occur here; let the rest surface.
- **Match the surrounding code.** Its naming, its comment density, its idioms, its import style. Code that reads as foreign is a defect even when it works.
- **Comments explain why, never what.** Delete a comment that restates the line beneath it.

## Vertical slices

Each task ends in something observable: a passing test that asserts real behavior through the public surface. Never leave a slice half-wired — an implemented module that nothing calls is an incomplete task, not a completed one.

## Reporting back

State plainly what was implemented, paste the actual test output, and name anything left unresolved. If the task turned out to be underspecified or wrong, say so instead of guessing silently — a wrong assumption buried in a passing test is worse than a question.
