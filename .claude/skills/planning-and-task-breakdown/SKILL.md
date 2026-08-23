---
name: planning-and-task-breakdown
description: Analyze a specification and codebase, then produce tasks/plan.md (architecture and design decisions) and tasks/todo.md (an ordered checkbox list of vertically-sliced tasks). Use when starting a feature and a written plan is needed before any code is written.
---

# Planning and Task Breakdown

Produce two files. Write no implementation code.

## Inputs to gather first

- The specification or user request, read in full.
- The existing codebase: languages, build tooling, test runner, conventions already in use.
- Real data or external systems the feature depends on. **Inspect them; do not assume.** A schema that contradicts the spec is a finding that belongs in the plan, not a surprise for the developer.

## Output 1 — `tasks/plan.md`

Sections, in order:

1. **Goal** — one paragraph: what exists when this is done.
2. **Constraints** — from the spec, plus discovered ones (readonly database, no absolute paths, must run over stdio, ...).
3. **Findings** — anything discovered that contradicts or is missing from the spec. Each finding states the evidence and the chosen response.
4. **Architecture** — modules, their responsibilities, and the boundaries between them. Name the public surface: exactly which functions or tools the outside world calls.
5. **Design decisions** — each as *decision → rationale → rejected alternative*. Keep these short; one to three lines each.
6. **Test strategy** — what is tested at the public boundary, what the adversarial cases are, and which runner executes them.
7. **Out of scope** — what deliberately is not built.

## Output 2 — `tasks/todo.md`

A flat, ordered checkbox list.

```markdown
# Todo

- [ ] 1. <task title>
      Deliverable: <what file or behavior exists afterwards>
      Test: <the failing test that proves it>
- [ ] 2. ...
```

Rules for the breakdown:

- **Vertical slices.** Each task ends with something observably working, never "write the types" followed by "now use them".
- **Ordered by dependency.** Task N may rely only on tasks before it.
- **One sitting each.** If a task cannot plausibly be implemented and tested in one focused pass, split it.
- **Every task names its test.** A task with no observable behavior to assert is a sign the slice is wrong.
- **Wiring last, but not never.** The task that makes the whole thing actually launch is itself a task.

## Handoff

Print a short summary for the user: task count, the riskiest task, and any finding from section 3 that needs a decision. Then stop and wait for approval.
