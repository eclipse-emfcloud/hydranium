# CPU

Read the `server-cpu` digest for the relevant window, with `server-summary`.
The digest ranks sampled self-time by function, not cumulative time including
callees. Its percentages use total attributed sample time, not request latency.
The top rows need not add to 100 percent because the digest truncates the list.

Use the raw `.cpuprofile` for call chains. A cheap function called repeatedly
from many documents can dominate the total; inspect callers and workload counts
before proposing a local rewrite. Digests aggregate by function, basename and
raw line number, so files with identical basenames can collide. Inspect full
URLs in the raw profile before naming a source location; V8 line numbers are
zero-based, and generated JavaScript may need source maps.

For a Langium build, distinguish parsing, linking, scope computation and
validation. If linking dominates only after an edit, investigate the number of
rebuilt documents and reference candidates before assuming a slow parser.
Use [framework passes](framework.md) when the question needs named phase costs.

Compare `cpuUsage.userMs` and `systemMs` with the summary's `durationMs`.
Process CPU can include more than the sampled JavaScript thread. Long wall time
with little process CPU calls for waiting, queueing, I/O or scheduling evidence;
a CPU profile cannot locate time spent awaiting a response. A slow UI with a
quiet server needs browser runtime or timeline evidence from the same action.

The digest charges each time delta to its sampled frame. Treat its ranking as
approximate; small differences from DevTools are not necessarily regressions.
Short captures and rare spikes can be missed by sampling. Repeat the workload
before treating a small change in rank as an improvement.
