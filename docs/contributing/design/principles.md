# Principles

The rules every part of the framework follows, and why. The other design pages
apply them to one area each; a change that breaks one of these needs a reason
strong enough to change the principle.

## One workspace, no head-to-head synchronisation

Every head reads and writes through one shared document store and one document
manager. No head synchronises with another: an edit made through one head is a
change to the shared document, and every other head observes it from there.
Adding a head therefore adds one consumer of the workspace, not a protocol to
every existing head. [Model coordination](model-coordination.md) describes the
mechanism.

## The protocol carries generic payloads

`@hydranium/protocol` holds the wire contracts and nothing of how a head
implements them. That the data head answers through `ModelService`, or that a
document is built by Langium, never shows in a request or a notification. A
client depends on the protocol alone, and a head can change its implementation
without changing a contract.

## A rejected write has no side effects

A write is checked before anything is applied, opened or written to disk. A
write that is refused leaves the document, the session and the disk as they
were, so a caller can retry or report without first undoing half an operation.

## Every multi-step operation has an owner at every point

Opening, watching, saving and releasing a document each span several steps,
and at each step one party owns the result. Dispose releases only what the
disposing party created. A cleanup that fails stays visible to the owner that
outlives it, rather than being swallowed where it happened.

## When unsure, deliver

Where the framework cannot tell whether a listener has seen an update, it
sends it again. A listener must tolerate an update it has already applied; a
missed update leaves a client wrong with nothing to show for it.

## Adopters subclass everything

Every DI slot is typed by an interface, and every class behind one is meant to
be extended. Members are `protected` rather than `private`, so a subclass can
reach what it needs to override. An override point is either policy or wiring,
never both, so overriding one does not mean reimplementing the other.
[Conventions](../conventions.md) has the rules in detail.

## Correctness over compatibility, before the first stable release

Every release is a prerelease that may break the API. When the correct design
and the compatible one differ, the framework takes the correct one and lists
the break, rather than carrying a wrong shape into the stable line.

## Messages say what happened and what to do

A message the framework shows or logs states what happened, how to see more,
and what to do about it. Code never points at a documentation page: a page
moves, and the message must stay true in the version that shipped it.

## Test doubles follow the real contract

A double behaves like the real implementation, including how it fails. A test
that passes against a double the real code would not match proves nothing about
the real code. [Testing](../testing.md) describes the layers this applies to.
