/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// The page's status line and log area: what the page is told and the errors
// it reports.

/** Replace the one-line status in the title bar. */
export function setStatus(text: string): void {
   (document.getElementById('status') as HTMLElement).textContent = text;
}

/** Add a line to the log area, kept scrolled to its end. */
export function appendLog(text: string): void {
   const log = document.getElementById('log') as HTMLElement;
   log.append(`${text}\n`);
   log.scrollTop = log.scrollHeight;
}
