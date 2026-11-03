# Framework pass timings

Read `frameworkPasses` in `server-summary` when the `framework` dimension was
enabled. Each record groups completed scopes by session and id, with a count,
self-time and share of capture duration. Absence means no usable pass evidence,
not that every pass was free.

These are instrumented wall-clock durations. An async scope includes waiting;
they are not sampled CPU time. Nested scopes are subtracted from their parent,
and overlapping sessions can make percentages sum above 100. Scopes crossing
capture boundaries are omitted. Do not add this table to the CPU table as if
the two accounted for disjoint work.

Use count and total together. A pass called more often after an edit may expose
rebuild fan-out, while a stable count with a longer duration may indicate more
work per document. Check the corpus and dependency graph before blaming the
pass implementation.

Instrumentation adds timing overhead, including to simultaneously sampled CPU
and allocation profiles. Use the same dimensions for a comparison. Once the
suspected pass is understood, repeat the user-visible workload without pass
instrumentation to confirm the improvement survives measurement overhead.
