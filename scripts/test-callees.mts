/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const TEST_ROOTS = new Set(['describe', 'suite', 'it', 'test']);
export const TEST_MODIFIERS = new Set([
   'describe',
   'skip',
   'only',
   'concurrent',
   'sequential',
   'todo',
   'fails',
   'each',
   'for',
   'skipIf',
   'runIf',
   'serial',
   'parallel',
   'fixme'
]);

export interface CalleePart<Node> {
   name: string;
   arguments?: readonly Node[];
   tagged?: boolean;
}

export type CalleeFrame<Node> =
   | { kind: 'member'; name: string; object: Node }
   | { kind: 'identifier'; name: string }
   | { kind: 'call'; callee: Node; arguments: readonly Node[] }
   | { kind: 'tag'; tag: Node }
   | { kind: 'wrapper'; expression: Node };

/** Parser adapters expose syntax; callers decide which chains are titles or enabled evidence. */
export function readCalleeChain<Node>(
   callee: Node | undefined,
   frameOf: (node: Node) => CalleeFrame<Node> | undefined
): CalleePart<Node>[] | undefined {
   const parts: CalleePart<Node>[] = [];
   let node = callee;
   let invocation: Pick<CalleePart<Node>, 'arguments' | 'tagged'> = {};
   while (node !== undefined) {
      const frame = frameOf(node);
      if (!frame) return undefined;
      switch (frame.kind) {
         case 'member':
            parts.unshift({ name: frame.name, ...invocation });
            invocation = {};
            node = frame.object;
            break;
         case 'identifier':
            parts.unshift({ name: frame.name, ...invocation });
            return parts;
         case 'call':
            invocation = { arguments: frame.arguments };
            node = frame.callee;
            break;
         case 'tag':
            invocation = { tagged: true };
            node = frame.tag;
            break;
         case 'wrapper':
            node = frame.expression;
            break;
      }
   }
   return undefined;
}
