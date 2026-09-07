# Security Policy

This Eclipse Foundation Project adheres to the [Eclipse Foundation Vulnerability Reporting Policy](https://www.eclipse.org/security/policy/).

## How To Report a Vulnerability

If you think you have found a vulnerability in this repository, please report it to us through coordinated disclosure.

**Please do not report security vulnerabilities through public issues, discussions, or pull requests.**

Instead, please create a [confidential issue](https://gitlab.eclipse.org/security/vulnerability-reports/-/issues/new?issuable_template=new_vulnerability) in the Eclipse Foundation Vulnerability Reporting Tracker.

You can find more information about reporting and disclosure at the [Eclipse Foundation Security page](https://www.eclipse.org/security/).

Please include as much of the information listed below as you can to help us better understand and resolve the issue:

- The type of issue (e.g., prototype pollution, path traversal, or arbitrary code execution)
- Affected package(s) and version(s)
- Impact of the issue, including how an attacker might exploit it
- Step-by-step instructions to reproduce the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Configuration required to reproduce the issue
- Proof-of-concept or exploit code (if possible)

This information will help us triage your report more quickly.

## Supported Versions

Hydranium is **alpha and pre-v0**, and is not yet published to npm. There are no
stable release lines, and therefore no maintained older versions: fixes land on
`main` and ship in the next release.

Once publishing begins, releases carry the `alpha` dist-tag and all
`@hydranium/*` packages version in lockstep, so a fix is delivered by taking the
current release of the whole set rather than by backporting to a branch. See
[`docs/adopting/status.md`](docs/adopting/status.md) for the versioning policy.

## Scope

Hydranium is a framework for building language servers, not a deployed service.
A report is most useful when it identifies something an *adopter's* product
would inherit — for example a parser input that crashes or hangs a server head,
a path in the filesystem seam that escapes the workspace root, or a
transport-level flaw in the RPC layer.

Two things are outside what the framework can fix, and are noted here so a
report is not filed against the wrong project:

- **Peer dependencies.** Theia, GLSP and the Eclipse stack beneath them are
  installed by the consuming application and carry their own security processes.
- **The `vscode-jsonrpc` packaging patch.** The patch in `patches/` is applied
  to a local install tree only, changes no runtime logic, and reaches no
  published tarball. See [`NOTICE.md`](NOTICE.md).
