/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { type GLSPClient } from '@eclipse-glsp/client';
import { BaseGLSPClientContribution } from '@eclipse-glsp/theia-integration';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { OutputChannelManager } from '@theia/output/lib/browser/output-channel';
import { WorkspaceService } from '@theia/workspace/lib/browser';

/** Options for `HydraniumGlspClientContribution`. The channel name is the
 *  Theia Output channel both the LSP and GLSP sides write to (so log lines
 *  interleave); the ready marker is a server-printed substring that signals
 *  "the GLSP server is accepting client connections". */
export interface ClientContributionOptions {
   readonly languageContributionId: string;
   readonly channelName: string;
   readonly readyMarker: string;
}

/**
 * Theia GLSP client contribution for adopters whose GLSP server runs in a
 * sideloaded VS Code extension process (or any other deferred-start setup).
 * The behaviours adopters reliably need are lifted:
 *
 *   1. `waitForBackendConnected`: tail the OutputChannel for a server-printed
 *      ready marker. While a socket connection might open earlier, the GLSP
 *      server typically does internal initialisation before it can accept
 *      client connections — we wait for it to say so.
 *   2. `start`: defer until a workspace is opened. If Theia starts without a
 *      workspace, this prevents the frontend-backend connection (and its
 *      "connecting" progress spinner) from firing prematurely.
 *
 * A `GLSPClient` override filtering inbound messages by clientId is
 * deliberately NOT provided: upstream's `BaseJsonrpcGLSPClient.onActionMessage`
 * already filters by clientId, so the `TheiaJsonrpcGLSPClient` returned by
 * `BaseGLSPClientContribution.createGLSPClient` is correct as-is.
 */
@injectable()
export class HydraniumGlspClientContribution extends BaseGLSPClientContribution {
   @inject(OutputChannelManager) protected outputChannelManager!: OutputChannelManager;
   @inject(WorkspaceService) protected readonly workspaceService!: WorkspaceService;

   readonly id: string;
   protected readonly channelName: string;
   protected readonly readyMarker: string;

   constructor(@unmanaged() options: ClientContributionOptions) {
      super();
      this.id = options.languageContributionId;
      this.channelName = options.channelName;
      this.readyMarker = options.readyMarker;
   }

   /** Wait for the server to print its ready marker into the OutputChannel.
    *  Resolves immediately if the marker is already present (server started
    *  before the client contribution mounted). */
   protected async waitForBackendConnected(): Promise<void> {
      const channel = this.outputChannelManager.getChannel(this.channelName);
      const channelText =
         (channel as unknown as { resource?: { textModel?: { getValue(): string } } }).resource?.textModel?.getValue() ?? '';
      if (channelText.includes(this.readyMarker)) {
         return;
      }
      const deferred = new Deferred<void>();
      const channelListener = channel.onContentChange(() => {
         const text = (channel as unknown as { resource?: { textModel?: { getValue(): string } } }).resource?.textModel?.getValue() ?? '';
         if (text.includes(this.readyMarker)) {
            channelListener.dispose();
            deferred.resolve();
         }
      });
      return deferred.promise;
   }

   protected override async start(glspClient: GLSPClient): Promise<void> {
      // Defer starting the GLSP client until a workspace is opened. If Theia
      // starts without a workspace, this prevents creating the frontend-
      // backend connection (and showing the "connecting" progress) prematurely.
      const roots = this.workspaceService.tryGetRoots();
      if (!roots || roots.length === 0) {
         await new Promise<void>(resolve => {
            const disposable = this.workspaceService.onWorkspaceChanged(changedRoots => {
               if (changedRoots && changedRoots.length > 0) {
                  disposable.dispose();
                  resolve();
               }
            });
         });
      }
      await this.waitForBackendConnected();
      return super.start(glspClient);
   }
}
