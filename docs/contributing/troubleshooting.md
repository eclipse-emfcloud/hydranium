# Troubleshooting the repository

Failure modes hit while building, testing or running **this repository** — as
opposed to a server built on the framework, whose failure modes are in
[Troubleshooting a server you are building](../adopting/troubleshooting.md).
Each entry starts with what you actually see.

Two entries live in that other file but bite here just as often: `instanceof`
answering `false` for a node that is obviously the right type, and `Unknown
parameter structure auto` during head initialization. Both are a duplicated
physical copy in the install, and both are fixed by a from-scratch install.

## `hydranium-cli: not found`, exit 127, during a build

```text
sh: 1: hydranium-cli: not found
```

Reported against whichever package's `generate` step runs first, and reported
several times as npm unwinds the script chain, so the tail of the log invites
blaming the code generator. The generator is fine.

`hydranium-cli` is a workspace package whose `lib/` is generated and not
committed. On a fresh clone the bin target does not exist when npm links
binaries, and npm skips such a link silently rather than warning — so the
install exits 0 with `node_modules/.bin/hydranium-cli` absent.

**Remedy:** build, then install again. That second install is a documented step,
not a workaround; see [Contributing](../../CONTRIBUTING.md).

```bash
npm install
npm run build
npm install
```

## `Cannot find module …/deps_ssr/<dep>.js` — every suite in one package

Every test in a single package fails on a missing module inside
`node_modules/.vite/vitest/<hash>/deps_ssr/`, naming a dependency you did not
touch, in a package your change did not touch. It reads as a broken install.

It is the vitest dep-optimizer cache, which packages that enable
`deps.optimizer` prebundle into. The directory is per-package shared state that
no build tooling owns: it appears in no turbo `inputs`, so turbo cannot see it
change, and in no `outputs`, so turbo never saves or restores it. The exposure
is concurrency rather than staleness — two vitest processes over one package,
one sweeping and rewriting while the other imports.

`TURBO_FORCE=true` does **not** help. It re-executes the task, the task is
vitest, and vitest then consults its own cache.

**Remedy:** the root `clean` script sweeps it, deliberately at the root so no
package has to remember.

```bash
npm run clean
```

## The Theia app exits at "loading modules", or its e2e reports "webServer exited early"

The backend prints `Backend server: loading modules...` and then stops, with no
error and no stack. Run it directly and the exit code is **139** — `128 + 11`,
a segfault — which is a native addon compiled against a different Node ABI than
the one running it. Switching Node versions between an install and a run is
enough to cause it; the addons that matter here are node-gyp *local compiles*
(`build/Release/obj.target/` beside them), not the ABI-stable N-API prebuilds.

Confirm which addon before rebuilding anything, because a probe that segfaults
stops at the FIRST bad file and tells you nothing about the ones after it:

```bash
node -e "process.dlopen({exports:{}}, require('path').resolve('<path>.node'))"
```

**Rebuilding `node_modules` alone will not fix it**, and this is what makes the
symptom look like a broken CLI rather than a broken addon. A Theia application
keeps its OWN copy of each native addon under `lib/backend/native/`, and
`theia start` runs `lib/backend/main.js` — not the `src-gen/backend/main.js`
that a hand-run `node` invocation reaches for. So the source tree can start
perfectly while the bundle keeps segfaulting. Repair both:

```bash
nvm use                                  # the version .nvmrc pins
npm rebuild                              # repairs node_modules
npm --prefix examples/order-flow/theia-app run build   # re-copies into lib/
```

## An e2e run fails on a port that nothing appears to be using

A Playwright suite that was working reports the port already in use, or a
`webServer` that never becomes ready, and no test process is running.

Playwright's `webServer` child **survives a SIGKILL of the Playwright process
group**. A run killed mid-flight — `Ctrl-C` twice, a stopped background job, an
editor closing a terminal — therefore leaves its server behind holding the port,
and the next run either reuses a stale server or cannot bind. A graceful stop
does not do this: Playwright reaps the child correctly when it is allowed to.

Confirm and clear it by port rather than by name, since the surviving process is
a plain `node` and matches nothing memorable:

```bash
ss -ltnp | grep <port>     # names the pid holding it
kill -9 <pid>
```

The example suites use **3001** (the Theia app) and **3002** (the browser page).

## Still stuck

Server-side logging is the fastest way to see which hop stalled, and the
framework's test-support layer can capture a per-test server log and attach it
to a failing test. [Testing](testing.md) covers the layers and the commands.
