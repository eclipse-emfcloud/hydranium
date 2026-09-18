---
'@hydranium/core': patch
'@hydranium/cli': patch
---

CLI driver children no longer get `--max-old-space-size=8192` under a cgroup
limit, where a ceiling above the limit means the kernel OOM-kills the container
before V8 collects. Node sizes the heap from the limit instead, which is a
fraction of it, so `HYDRANIUM_CLI_MAX_OLD_SPACE_MB` states a ceiling that wins
either way; a value below 256 MiB or carrying a unit suffix is reported and
ignored. `@hydranium/core/node` exports the decision as `heapCeilingArgs` and
the container test as `isMemoryConstrained`.
