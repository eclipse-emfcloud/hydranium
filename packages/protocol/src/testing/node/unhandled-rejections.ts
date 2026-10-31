/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Run a Node-only assertion while collecting process-level unhandled rejection
 * events. The callback owns the event-loop drain and can therefore choose the
 * right observation window for the operation under test.
 *
 * Inside the window a rejection reaches only the array: while any listener is
 * registered, Node hands none to its default handler and Vitest reports none as
 * an error. A callback that never asserts on the array therefore hides every
 * rejection it provokes.
 */
export async function captureUnhandledRejections<T>(callback: (rejections: unknown[]) => Promise<T>): Promise<T> {
   const rejections: unknown[] = [];
   const listener = (reason: unknown): void => {
      rejections.push(reason);
   };
   process.on('unhandledRejection', listener);
   try {
      return await callback(rejections);
   } finally {
      process.off('unhandledRejection', listener);
   }
}
