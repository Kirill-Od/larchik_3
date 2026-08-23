---
name: pull-request
description: Commit finished work using Conventional Commits and, where a remote exists, push a branch and open a GitHub pull request. Use as the final publishing step once all tasks are complete and review is clean.
---

# Publishing a Change

## 1. Establish the repository

Run `git status`. If the directory is not a repository, run `git init` and write a `.gitignore` appropriate to the stack before staging anything.

Never commit on the default branch. Create a descriptive branch: `feat/<slug>`, `fix/<slug>`.

## 2. Review what you are about to commit

`git status --short` and `git diff`. Confirm before staging:

- No secrets, credentials, `.env` files, or personal absolute paths.
- No build output, `node_modules`, `__pycache__`, or editor cruft.
- No scratch or debug files that were never part of the deliverable.
- Binary assets are intentional — a committed database file is a deliberate decision, not an accident.

Stage deliberately. Prefer naming paths over `git add -A` when the working tree holds anything you have not just inspected.

## 3. Commit

Conventional Commits: `type(scope): summary` in the imperative, under ~72 characters.

`feat` `fix` `docs` `test` `refactor` `chore` `build`

The body explains **why** the change exists and calls out anything surprising a reader would otherwise have to reconstruct.

## 4. Publish

**With a configured remote:** push the branch, then `gh pr create` with a title matching the commit and a body covering summary, notable decisions, and how to verify. Return the PR URL.

**With no remote:** stop after committing. Report the branch name, the commit, and `git log --oneline`. State plainly that nothing was pushed — do not create a remote repository, and do not treat local commits as a published pull request.

## Rules

- Never `push --force` to a shared branch.
- Never commit or push work the review gate has not cleared.
- Report what actually happened. If the push or PR creation failed, say so with the error, rather than reporting success up to the last step that worked.
