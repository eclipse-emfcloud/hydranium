/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Messenger } from 'vscode-messenger';
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common';
import { Messenger as WebviewMessenger, type VsCodeApi } from 'vscode-messenger-webview';

/** One webview on a {@link MessengerHarness}. */
export interface MessengerHarnessWebview {
   /** How the extension-side messenger addresses this webview. */
   readonly participant: WebviewIdMessageParticipant;
   /** The webview's own messenger, already started. */
   readonly messenger: WebviewMessenger;
   /** Close the webview, as VS Code disposing its panel does: the extension-side messenger forgets it. */
   dispose(): void;
}

/** The real `vscode-messenger` classes, joined without VS Code. */
export interface MessengerHarness {
   /** The extension host's messenger, constructed as `GlspVscodeConnector` constructs its own. */
   readonly extension: Messenger;
   /** Open a webview: a panel registered with {@link extension}, and the webview's messenger behind it. */
   openWebview(): MessengerHarnessWebview;
   /**
    * Restore the global `window` this harness replaced. A webview messenger
    * reads `window.crypto` for every request it sends, so its requests throw
    * once the harness is disposed; notifications still go.
    */
   dispose(): void;
}

/** What the webview messenger reads from the global `window`. */
interface HarnessWindow {
   addEventListener(type: string, listener: (event: { data: unknown }) => void): void;
   readonly crypto: typeof globalThis.crypto;
}

/**
 * Join the real extension-side and webview-side messengers in a Node test,
 * through a fake webview panel on one end and a fake `window` on the other.
 *
 * Both classes run unchanged, so their routing is the real one: delivery is
 * asynchronous, the webview side keeps one handler per method, and the
 * extension side filters by sender. The webview messenger listens on the
 * global `window`, so the harness installs one for its lifetime and routes each
 * listener to the webview that registered it.
 *
 * One harness at a time: a second replaces the `window` the first routes its
 * webviews through, and disposing them out of order restores the wrong one.
 */
export function makeMessengerHarness(): MessengerHarness {
   const host = globalThis as { window?: unknown };
   const previousWindow = host.window;
   let starting: Array<(event: { data: unknown }) => void> | undefined;
   const harnessWindow: HarnessWindow = {
      addEventListener: (type, listener) => {
         if (type === 'message') {
            starting?.push(listener);
         }
      },
      crypto: globalThis.crypto
   };
   host.window = harnessWindow;
   const extension = new Messenger({ ignoreHiddenViews: false });

   return {
      extension,
      openWebview: () => {
         const toWebview: Array<(event: { data: unknown }) => void> = [];
         const toExtension: Array<(message: unknown) => void> = [];
         const disposeListeners: Array<() => void> = [];
         const panel = {
            viewType: 'hydranium.messengerHarness',
            visible: true,
            webview: {
               postMessage: async (message: unknown) => {
                  [...toWebview].forEach(listener => listener({ data: message }));
                  return true;
               },
               onDidReceiveMessage: (listener: (message: unknown) => void) => {
                  toExtension.push(listener);
                  return {
                     dispose: () => {
                        const index = toExtension.indexOf(listener);
                        if (index >= 0) {
                           toExtension.splice(index, 1);
                        }
                     }
                  };
               }
            },
            onDidDispose: (listener: () => void) => {
               disposeListeners.push(listener);
               return { dispose: () => undefined };
            },
            onDidChangeViewState: () => ({ dispose: () => undefined })
         };
         // The members the extension-side messenger reads; the rest of a panel is VS Code's.
         const participant = extension.registerWebviewPanel(panel as unknown as Parameters<Messenger['registerWebviewPanel']>[0]);
         const vscodeApi: VsCodeApi = {
            postMessage: message => [...toExtension].forEach(listener => listener(message)),
            getState: () => undefined,
            setState: () => undefined
         };
         const messenger = new WebviewMessenger(vscodeApi);
         starting = toWebview;
         messenger.start();
         starting = undefined;
         return { participant, messenger, dispose: () => disposeListeners.forEach(listener => listener()) };
      },
      dispose: () => {
         host.window = previousWindow;
      }
   };
}
