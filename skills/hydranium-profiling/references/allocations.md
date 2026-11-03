# Allocations

Read the `server-alloc` digest for the window. It ranks the sampling heap
profile's `selfSize` by allocation frame. This is sampled allocation
attribution. It is neither an exact allocation total for the workload nor the
dominator-retained size of those objects.

The capture starts V8 sampling with a sampling interval, without opting into
including objects collected by major or minor GC. Do not describe the result
as a complete history of short-lived allocation churn. A low ranking cannot
exclude a high rate of temporary allocations that have already been collected.

Use the raw `.heapprofile` when a factory needs caller context. A shared range
or description constructor can appear expensive because many language features
use it. Associate the call tree with parse size, references and rebuild counts
before attributing the cost to one feature.

Combine the result with [GC](gc.md) and equivalent post-GC measurements. High
allocation attribution with a stable retained heap does not establish a leak.
Retained growth needs [heap ownership](heap.md) evidence. Conversely, changing
one allocation site may reduce temporary work without reducing resident memory.

For a proposed change, keep the sampling interval, workload and runtime fixed.
Check the resulting behavior as well as allocations: avoiding descriptions or
cached ranges is not a valid optimization if lookup or source locations break.
