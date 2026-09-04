/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Two test primitives for awaiting in-process asynchrony (RPC notifications
 * crossing the duplex wire, `DocumentBuilder` phase events, etc.) WITHOUT a
 * flaky fixed sleep.
 *
 * Decision rule:
 * - Asserting an effect **will** happen ("eventually N events / a build ran /
 *   the doc reached a phase")? → {@link waitFor} with a predicate over the
 *   observable. Non-racy: resolves the instant it is true, tolerates a slow CI.
 * - Asserting an effect **did not / has not yet** happened ("no event for an
 *   unsubscribed URI", "the gated call has not resolved")? → {@link tick}: a
 *   negative cannot be polled, so yield the loop a bounded moment to give the
 *   (unwanted) effect a chance, then assert its absence.
 *
 * Default to `waitFor`; reach for `tick` only when the assertion is an absence.
 * A microtask flush (`await Promise.resolve()` / `queue-microtask`) is never the
 * answer here — stream-delivered JSON-RPC notifications arrive on a macrotask/IO
 * turn, after microtasks drain.
 */

/** Options for {@link waitFor}. */
export interface WaitForOptions {
   /** Reject after this many milliseconds if the predicate is still false. Default 2000. */
   readonly timeoutMs?: number;
   /** Poll the predicate every this-many milliseconds. Default 5. */
   readonly intervalMs?: number;
   /** Error message on timeout. Default a generic phrasing. */
   readonly message?: string;
}

/**
 * Resolve once `predicate()` returns true, polling at `intervalMs`; reject with
 * `message` once `timeoutMs` elapses. The **non-racy** alternative to a fixed
 * sleep for awaiting an asynchronous side effect that lands on an observable
 * value.
 *
 * It resolves the instant the condition holds, so it is *faster* than a fixed
 * delay on the happy path, and tolerates a slow event loop up to `timeoutMs`, so
 * it does not flake under parallel CI where a fixed `setTimeout` can be starved
 * past the test timeout.
 *
 * @example
 * await proxy.updateModelDocument({ uri, clientId, model });
 * await waitFor(() => harness.events.length === 1); // the notification crossed
 * expect(harness.events[0].document.uri).toBe(uri);
 */
export function waitFor(predicate: () => boolean, options: WaitForOptions = {}): Promise<void> {
   const timeoutMs = options.timeoutMs ?? 2000;
   const intervalMs = options.intervalMs ?? 5;
   const message = options.message ?? `Timed out after ${timeoutMs}ms waiting for a condition`;
   if (predicate()) {
      return Promise.resolve();
   }
   return new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
         clearInterval(poll);
         reject(new Error(message));
      }, timeoutMs);
      const poll = setInterval(() => {
         if (predicate()) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
         }
      }, intervalMs);
   });
}

/**
 * Yield the event loop for `ms` (default 10). The bounded counterpart to
 * {@link waitFor}, for the rare assertion that something has NOT happened — a
 * *negative* you cannot poll positively. Give async delivery a real chance to
 * (wrongly) occur, then assert it did not.
 *
 * A fixed yield is unavoidable here, but the failure mode is a false-green, not
 * the flaky-red a fixed delay causes on a positive wait.
 *
 * @example
 * await proxy.saveModelDocument({ uri, clientId, model }); // no subscriber yet
 * await tick();                  // give a (wrongly) fired event a chance to land
 * expect(savedEvents).toHaveLength(0); // assert the ABSENCE
 */
export function tick(ms = 10): Promise<void> {
   return new Promise<void>(resolve => setTimeout(resolve, ms));
}
