/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The two controls over the server-log panel, which act on different halves of
 * the wire and must not be conflated: the level sets the SERVER's threshold over
 * LSP configuration, while the trace is this page printing its own message
 * traffic and reaches no server. Turning the trace up adds no server output, and
 * raising the level adds no message log.
 */

import { isLogThreshold, type LogThreshold } from '@hydranium/protocol';
import { type MessageConnection, Trace, type Tracer } from 'vscode-jsonrpc/browser';
import { ConfigurationRequest, DidChangeConfigurationNotification, MessageType } from 'vscode-languageserver-protocol';
import { requireSelect } from './dom.js';
import type { LogPanel } from './log-panel.js';

/**
 * The section this server reads its settings under — a host-side copy of its
 * `lsp.configurationRoot`, which cannot be imported here: it is declared in the
 * language module, and that graph would put the whole language server in the
 * page bundle. A drift leaves every answer `null`, so the setting reads as unset.
 */
const CONFIGURATION_SECTION = 'order-flow';

/**
 * Every threshold, as a Record so a level added to the framework fails this
 * build rather than going missing from the picker. The values are also the
 * labels: they are the words a reader matches against log output, so translating
 * them would break the match.
 */
const LOG_LEVELS: Readonly<Record<LogThreshold, string>> = {
   off: 'off',
   error: 'error',
   warn: 'warn',
   info: 'info',
   debug: 'debug',
   trace: 'trace'
};

/** The framework's own default, mirrored so the picker opens showing what is in force. */
const DEFAULT_LEVEL: LogThreshold = 'info';

/**
 * The level this session starts at, from `?log=`, which is the only way to have
 * one in force before the server's first read — the path the configuration FETCH
 * serves, as distinct from the push a later pick travels. An unparseable value
 * leaves the default rather than failing the page.
 */
function initialLevel(): LogThreshold {
   const requested = new URLSearchParams(window.location.search).get('log');
   return isLogThreshold(requested) ? requested : DEFAULT_LEVEL;
}

/** `vscode-jsonrpc` trace values, by the words a shell's trace setting uses. */
const TRACE_VALUES: Readonly<Record<string, Trace>> = {
   off: Trace.Off,
   messages: Trace.Messages,
   verbose: Trace.Verbose
};

/**
 * Wire the level picker as a configuration client.
 *
 * Call before `initialize`: the server reads its section while the workspace
 * comes up, and a handler registered after that leaves the request unanswered,
 * which the server cannot tell from a client that has no settings.
 */
export function wireLogLevelControl(connection: MessageConnection): void {
   const control = requireSelect('log-level');
   let level: LogThreshold = initialLevel();

   control.replaceChildren(
      ...Object.entries(LOG_LEVELS).map(([value, label]) => {
         const option = document.createElement('option');
         option.value = value;
         option.textContent = label;
         option.selected = value === level;
         return option;
      })
   );

   // One answer per item: a request carries several sections and the response is
   // positional, so dropping the unknown ones mis-aligns every later answer.
   connection.onRequest(ConfigurationRequest.type, params =>
      params.items.map(item => (item.section === CONFIGURATION_SECTION ? { log: { level } } : null))
   );

   control.addEventListener('change', () => {
      if (!isLogThreshold(control.value)) {
         return;
      }
      level = control.value;
      // The section's whole subtree: the server replaces its cached section with
      // what arrives, so a partial push deletes the siblings it omits.
      void connection.sendNotification(DidChangeConfigurationNotification.type, {
         settings: { [CONFIGURATION_SECTION]: { log: { level } } }
      });
   });
}

/**
 * Wire the message-trace picker onto the connection's own tracer.
 *
 * Marked here rather than left bare, because the panel's other lines arrive
 * pre-formatted from the server and nothing else distinguishes locally traced
 * traffic from something the server said.
 */
export function wireTraceControl(connection: MessageConnection, log: LogPanel): void {
   const control = requireSelect('log-trace');
   const tracer: Tracer = {
      log: (message: string | unknown, data?: string) => {
         const text = typeof message === 'string' ? message : JSON.stringify(message);
         log.append(MessageType.Log, `[Trace] ${text}${data === undefined ? '' : ` ${data}`}`);
      }
   };

   control.replaceChildren(
      ...Object.keys(TRACE_VALUES).map(value => {
         const option = document.createElement('option');
         option.value = value;
         option.textContent = value;
         option.selected = value === 'off';
         return option;
      })
   );

   control.addEventListener('change', () => {
      void connection.trace(TRACE_VALUES[control.value] ?? Trace.Off, tracer);
   });
}
