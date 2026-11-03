# Event-loop delay

Read `eventLoopDelay` in the window's `server-summary`. The reported mean, p50,
p99 and maximum are milliseconds. An absent histogram is not evidence of zero
delay: a short or synchronous workload can leave the sampler without samples.

These values measure delay in servicing the sampler, not end-to-end request
latency. A high maximum identifies a stall somewhere in the window; it does not
identify its cause. A high p99 from a small sample population is weak evidence
for a stable tail-latency claim.

Compare with [CPU](cpu.md), [GC](gc.md), server logs and `server-latency` when
present. Sustained CPU-heavy synchronous parsing or validation can delay other
work. Queueing and asynchronous I/O can make a request slow without blocking the
event loop. Container CPU throttling or host contention is another hypothesis;
the manifest's container flag alone does not prove either.

For an app capture, separate the server loop from the renderer. Browser runtime,
timeline and console artifacts can show rendering work or errors absent from a
headless capture. A server delay histogram cannot establish renderer jank.

Narrow a long mixed window to the action that feels slow, retaining enough
iterations for the sampler. Confirm that any proposed yielding or scheduling
change preserves workspace ordering and cancellation before calling it a fix.
