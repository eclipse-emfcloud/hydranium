/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * The real messenger classes against the shapes the channel restates.
 *
 * The proof is the compile, under `typecheck:test`: each function below only
 * type-checks while the real class is assignable to its restatement, so a
 * `vscode-messenger` release that changes a used method fails here rather than
 * in a webview. The runtime assertions only keep the functions referenced.
 */

import type { MessageParticipant } from 'vscode-messenger-common';
import type { Messenger } from 'vscode-messenger';
import type { Messenger as WebviewMessenger } from 'vscode-messenger-webview';
import { describe, expect, it } from 'vitest';
import type { MessengerLike, WebviewMessengerLike } from '../src/messenger-channel';

describe('messenger conformance', () => {
   it('holds the extension-side messenger to MessengerLike', () => {
      const conforms = (messenger: Messenger): MessengerLike<MessageParticipant> => messenger;
      expect(conforms).toBeTypeOf('function');
   });

   it('holds the webview-side messenger to WebviewMessengerLike', () => {
      const conforms = (messenger: WebviewMessenger): WebviewMessengerLike<MessageParticipant> => messenger;
      expect(conforms).toBeTypeOf('function');
   });
});
