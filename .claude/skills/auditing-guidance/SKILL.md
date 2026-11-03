---
name: auditing-guidance
description: Re-verify repository agent guidance against source and probes during a manual periodic audit or after architecture or dependency changes.
---

# Auditing agent guidance

This review is for framework contributors. It runs on request, outside the
gate; installing the skill does not schedule it.

1. Enumerate `AGENTS.md`, `CLAUDE.md`, and the rules and skills under
   `.claude/`. Exclude skills named in `skills-lock.json`, whose text is
   vendored. Read every remaining instruction, including linked rule pages
   when an instruction delegates its contract to them.
2. For each factual sentence, find its source, configuration or test.
   Verify the default binding and the conditions under which the sentence
   holds. A matching name alone is not evidence of behavior.
3. Run cheap probes for upstream assumptions. For an expensive host trace,
   inspect the installed dependency's implementation and report what was
   inspected and what remains unverified. Do not turn an unrun trace into a
   test claim.
4. Check each claim marker against the assertion, then run its test. Follow
   [the test control rules](../../../docs/contributing/testing.md#writing-a-test)
   before trusting new coverage. Add reciprocal markers for claims that
   already have tests, using the
   [evidence format](../../../docs/contributing/conventions.md#agent-guidance-evidence).
5. Correct false instructions and contradictory guidance at their home,
   following the
   [documentation rules](../../../docs/contributing/conventions.md#comments-and-documentation).
   Run `npm run check:docs` and report the corrected claims, evidence used,
   and remaining gaps. A green gate alone is not an audit result.
