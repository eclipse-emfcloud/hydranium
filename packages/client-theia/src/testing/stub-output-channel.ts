/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Minimal fake `OutputChannel` that captures appended lines into an array. */
export interface StubOutputChannel {
   readonly name: string;
   readonly lines: string[];
   appendLine(line: string): void;
}

/**
 * Minimal fake `OutputChannelManager` handing out {@link StubOutputChannel}s.
 * Use in unit tests of `ChannelLogger` (and its subclasses) and of any consumer
 * that injects an output channel.
 */
export interface StubOutputChannelManager {
   readonly channels: ReadonlyMap<string, StubOutputChannel>;
   getChannel(name: string): StubOutputChannel;
}

export function makeStubOutputChannelManager(): StubOutputChannelManager {
   const channels = new Map<string, StubOutputChannel>();
   return {
      channels,
      getChannel(name: string): StubOutputChannel {
         let channel = channels.get(name);
         if (!channel) {
            const lines: string[] = [];
            channel = {
               name,
               lines,
               appendLine(line: string): void {
                  lines.push(line);
               }
            };
            channels.set(name, channel);
         }
         return channel;
      }
   };
}
