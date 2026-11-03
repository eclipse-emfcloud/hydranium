---
name: hydranium-profiling
description: >-
  Interpret Hydranium profiling sessions, CPU and allocation profiles, GC and
  event-loop summaries, framework pass timings, and server or renderer heaps.
  Use when investigating a language application's performance or memory use.
license: MIT
metadata:
  hydranium-compatibility-schema: '2'
  hydranium-requires: >-
    {"@hydranium/core":"1.0.0-next.411","@hydranium/cli":"1.0.0-next.411"}
  hydranium-contracts: >-
    {"@hydranium/core":{"profiling":"1"},
    "@hydranium/cli":{"profiling":"1"}}
---

# Interpret a Hydranium profiling session

Start with the user's symptom and the capture they already have. Do not launch
a workload, modify models, or collect a heap merely because this skill loaded.

1. Check the installed framework and CLI versions against this skill's
   metadata. Where available, run `hydranium-cli check-skills` from the project,
   selecting `--skill hydranium-profiling`; use `--from server` if dependencies
   resolve from that package. An older CLI may lack this command: read installed
   package manifests instead. An unverified or incompatible result requires
   checking commands with that installation's `--help` and checking internals
   against its source. Do not interpret a compatible result as proof of a
   diagnosis. For historical captures, the capture's revision takes precedence
   over the dependencies installed today.
2. Read `manifest.json` before opening large artifacts. This skill understands
   profiling schema 1. For another schema, inspect its producer before assuming
   field meanings. Record `environment.mode`, workspace, commit if present,
   container flag, and windows. The manifest's Node version belongs to its
   writer; an app capture's writer can be the test runner rather than the
   server.
3. Follow `artifacts` paths and their optional `digest` paths. Match artifacts
   by origin and window. Missing artifacts mean missing evidence, not zero cost.
   Read summaries and digests first; open raw profiles for caller context or
   attribution the digest cannot supply.
4. Route only to the references relevant to the question:

   | Question | Reference |
   |---|---|
   | Which functions consume CPU? | [CPU](references/cpu.md) |
   | Where are sampled objects allocated? | [Allocations](references/allocations.md) |
   | Is collection consuming time? | [GC](references/gc.md) |
   | Why does the server stop responding? | [Event loop](references/event-loop.md) |
   | Which objects remain alive, and why? | [Heap](references/heap.md) |
   | Which named framework pass takes time? | [Passes](references/framework.md) |

5. Compare equivalent workloads: same corpus and document count, edit pattern,
   runtime, host, warmup, capture dimensions and window. A headless build has no
   live editor or diagram session. A renderer capture describes another process.
   Do not combine their heaps or treat one as evidence about the other.
6. Report the observation with artifact and window, the interpretation, what
   remains uncertain, and the smallest measurement that would distinguish the
   competing explanations. A proposed optimization needs a repeatable before
   and after run, plus a check that language behavior still holds.

There is no universal healthy heap size or milliseconds-per-document figure.
Langium cost depends on AST/CST size, exported descriptions, reference density,
validation and rebuild fan-out. Compare repeated runs and scaling with corpus
size. Persistent post-GC growth under an equivalent repeated operation is a
reason to inspect retention; one larger snapshot alone is not a leak finding.

When a new headless capture is appropriate and authorized, check the installed
`measure-memory --help`. `--services` selects the adopter's built services
module; its package configuration may already supply it. `--profile` selects
dimensions, including `framework` for instrumented passes. Build the adopter's
code first. Capturing every dimension adds overhead and is rarely necessary
for every comparison.
