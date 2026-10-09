---
name: writing-docs
description: Use when writing or editing documentation in this repository — a page under docs/, the root README, a package README under packages/, or an example README under examples/.
---

# Writing documentation

The rules live in one place: the "Comments and documentation" section of
[conventions](../../../docs/contributing/conventions.md#comments-and-documentation).
Read it before the first edit. This skill is the order to apply them in.

1. **Name the page's audience and type.** Evaluator, adopter or framework
   developer; guide, concept page, design page, package README or example
   README. A fact an adopter needs goes on an adopter page.
2. **Find the fact's home before writing it.** If another page already holds
   it, link that page instead of repeating it.
3. **Check every claim against the code or the tool** before it is written:
   that a symbol is exported, which option names a default, what a command's
   `--help` says, what a script prints. Cite nothing from memory.
4. **Keep a detail only if it passes the usefulness test**, and delete
   restated code rather than move it.
5. **After a change, search for every mention of what changed** with
   `git grep`, in docs, READMEs and code comments, and fix each one.
6. **Run the gates:** `npm run check:docs`, `npm run check:readmes` and
   `npm run check:readme`. Then mirror CI: pipe
   `git diff --name-only --no-renames origin/main...HEAD` into
   `node scripts/ci-changed.mts`; for `full=false` run
   `node scripts/run-gate.mts check:rest`, otherwise `npm run check`.
