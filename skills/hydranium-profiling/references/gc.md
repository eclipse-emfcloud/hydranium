# Garbage collection

Read `gc` in the relevant `server-summary`: count, total pause time and the
breakdown by kind. GC has no separate profile artifact. An absent field means
the dimension was not available, whereas a captured count of zero means no
entries were recorded in that window.

Relate pause time to the same window's `durationMs` and to repeated equivalent
runs. A total does not identify the longest pause, its position in the workload,
or a particular slow request. Correlate event-loop and latency evidence rather
than asserting that a request overlapped a collection from totals alone.

Frequent collection with a stable post-GC baseline suggests allocation pressure
rather than retained growth. Increasing post-GC baselines across equivalent edit
cycles justify inspecting [heap holders](heap.md). Compare an initialized
workspace with another initialized workspace, not with an empty process: ASTs,
CSTs, descriptions and reference indexes are expected resident data.

Account for collection induced by the measurement. `measure-memory` takes
post-GC readings; its collections are part of that experimental workload.
The capture samples CPU and memory at its workload boundary before serializing
profiles and writing its final heap snapshot. The snapshot's forced collection
does not make an earlier `memoryDelta.heapUsedBytes` a post-GC measurement.

Changing heap limits can change collection frequency without correcting the
underlying allocation or retention. Establish which cost is problematic before
recommending a larger heap.
