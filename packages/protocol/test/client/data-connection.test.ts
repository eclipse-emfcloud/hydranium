/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Several participants over one data connection, each a client session the
 * server registered.
 *
 * The assertions read what the SERVER received, and in what order: the server
 * keys its opens and watches per `(uri, clientId)`, and the session model rests
 * on the registration arriving before the session's first call and on a close
 * arriving after the calls it must not overtake. Only the wire shows either.
 *
 * Closes fired without being awaited are polled for, never timed. `tick` stays
 * right for the assertions that are an ABSENCE, which no amount of polling can
 * establish.
 */

import { describe, expect, it, vi } from 'vitest';
import { ResponseError, type MessageConnection } from 'vscode-jsonrpc';
import { FRAMEWORK_CLIENT_IDS } from '../../src/client-ids';
import { DataConnection, DataConnectionWithEvents } from '../../src/client/data-connection';
import { DataEvents } from '../../src/client/data-events';
import { DATA_SESSION_UNSAVED_LOST, DataSession, type DataSessionHost } from '../../src/client/data-session';
import { DATA_SERVER_WIRE_PREFIX, type DataServerProtocol } from '../../src/data';
import { DuplicateClientIdError, isDuplicateClientIdError, isSessionClosedError } from '../../src/errors';
import { bindRpcMethods } from '../../src/rpc/bind-rpc-methods';
import { tick, waitFor } from '../../src/testing';
import { type FakeDataPort, makeFakeDataPort } from '../../src/testing/data-doubles';
import { makeDuplexConnectionPair } from '../../src/testing/node';
import type { TransferElement } from '../../src/transfer-element';

interface ProbeElement extends TransferElement {
   $type: 'TypeOne';
}

type Method = 'createSession' | 'closeSession' | 'open' | 'create' | 'watch' | 'close' | 'update' | 'updates' | 'save';

interface ServerCall {
   readonly method: Method;
   readonly clientId: string;
   readonly uri?: string;
   readonly basedOn?: unknown;
   readonly model?: unknown;
   /** For `updates`: each update's `uri` and `basedOn`. */
   readonly updates?: readonly { readonly uri: string; readonly basedOn: unknown }[];
}

const URI_A = 'file:///a.x';
const URI_B = 'file:///b.x';
const URI_C = 'file:///c.x';
const MODEL = { $type: 'TypeOne' } as const;

function document(uri: string, version = 1, dirty?: boolean): unknown {
   return { uri, version, root: { $type: 'TypeOne' }, diagnostics: [], ...(dirty !== undefined ? { dirty } : {}) };
}

/** A promise a test releases by hand, for holding a server handler open. */
interface Gate {
   readonly promise: Promise<void>;
   release(): void;
}

function gate(): Gate {
   let release!: () => void;
   const promise = new Promise<void>(resolve => {
      release = resolve;
   });
   return { promise, release };
}

/** Knobs a lifecycle test needs and a plain echo cannot give it. Read per call, so a test can flip them. */
interface ServerBehaviour {
   /** Held before the readiness gate answers. */
   readyGate?: Promise<void>;
   /** Held before an open answers. */
   openGate?: Promise<void>;
   /**
    * The version an open and an update of a URI answer with. Absent, an update
    * answers 1 and an open the count of opens so far, so a re-open is told
    * apart from the first.
    */
   versions?: Map<string, number>;
   /** Held before the registration answers. */
   createGate?: Promise<void>;
   /** Held before an update answers. */
   updateGate?: Promise<void>;
   /** Held before a save answers. */
   saveGate?: Promise<void>;
   /** Refuse every registration as a duplicate id. */
   refuseSessions?: boolean;
   failWatch?: boolean;
   /** Per URI, the `dirty` an open and a read answer with; absent, they carry none. */
   dirty?: Map<string, boolean>;
   /** Runs as a watch arrives, before it answers. */
   beforeWatch?: (uri: string) => void;
   /** URIs whose open fails. */
   failOpens?: Set<string>;
   /**
    * The URI an answer names for the URI a call named, as a server keys its
    * documents; absent, the one the call named.
    */
   canonical?: (uri: string) => string;
}

/**
 * Bind a server that records every call, on one connection generation. The
 * `calls` array is shared across generations, and an open answers with a
 * version counting every open so far, so a re-open is told apart from the
 * first.
 */
function recordingServer(connection: MessageConnection, calls: ServerCall[], behaviour: ServerBehaviour): void {
   const record = (
      method: Method,
      args: { clientId: string; uri?: string; basedOn?: unknown; model?: unknown; updates?: { uri: string; basedOn: unknown }[] }
   ): void => {
      const call: ServerCall = { method, clientId: args.clientId };
      calls.push({
         ...call,
         ...(args.uri !== undefined ? { uri: args.uri } : {}),
         ...(args.basedOn !== undefined ? { basedOn: args.basedOn } : {}),
         ...(args.model !== undefined ? { model: args.model } : {}),
         ...(args.updates !== undefined ? { updates: args.updates.map(update => ({ uri: update.uri, basedOn: update.basedOn })) } : {})
      });
   };
   const answered = (uri: string): string => behaviour.canonical?.(uri) ?? uri;
   const target = {
      waitForReady: async (): Promise<void> => {
         await behaviour.readyGate;
      },
      createSession: async (args: { clientId: string }): Promise<void> => {
         record('createSession', args);
         await behaviour.createGate;
         if (behaviour.refuseSessions) {
            throw new DuplicateClientIdError(args.clientId);
         }
      },
      closeSession: async (args: { clientId: string }): Promise<void> => {
         record('closeSession', args);
      },
      openModelDocument: async (args: { uri: string; clientId: string }): Promise<unknown> => {
         record('open', args);
         await behaviour.openGate;
         if (behaviour.failOpens?.has(args.uri)) {
            throw new Error('open refused');
         }
         return document(
            answered(args.uri),
            behaviour.versions?.get(args.uri) ?? calls.filter(call => call.method === 'open').length,
            behaviour.dirty?.get(args.uri)
         );
      },
      getModelDocument: async (args: { uri: string }): Promise<unknown> => document(answered(args.uri), 1, behaviour.dirty?.get(args.uri)),
      createModelDocument: async (args: { uri: string; clientId: string }): Promise<unknown> => {
         record('create', args);
         return document(answered(args.uri));
      },
      watchModelDocument: async (args: { uri: string; clientId: string }): Promise<void> => {
         record('watch', args);
         behaviour.beforeWatch?.(args.uri);
         if (behaviour.failWatch) {
            throw new Error('watch refused');
         }
      },
      closeModelDocument: async (args: { uri: string; clientId: string }): Promise<void> => {
         record('close', args);
      },
      updateModelDocument: async (args: { uri: string; clientId: string; basedOn: unknown; model: unknown }): Promise<unknown> => {
         record('update', args);
         await behaviour.updateGate;
         return document(answered(args.uri), behaviour.versions?.get(args.uri) ?? 1);
      },
      updateModelDocuments: async (args: { clientId: string; updates: { uri: string; basedOn: unknown }[] }): Promise<unknown> => {
         record('updates', args);
         return args.updates.map(update => document(answered(update.uri), behaviour.versions?.get(update.uri) ?? 1));
      },
      saveModelDocument: async (args: { uri: string; clientId: string }): Promise<unknown> => {
         record('save', args);
         await behaviour.saveGate;
         return document(answered(args.uri));
      }
   };
   bindRpcMethods(
      connection,
      target,
      [
         'waitForReady',
         'createSession',
         'closeSession',
         'openModelDocument',
         'getModelDocument',
         'createModelDocument',
         'watchModelDocument',
         'closeModelDocument',
         'updateModelDocument',
         'updateModelDocuments',
         'saveModelDocument'
      ],
      { methodNamespace: DATA_SERVER_WIRE_PREFIX }
   );
}

/** A connection that shows what it recorded of the dirty states its client was told. */
class InspectableConnection extends DataConnection<ProbeElement> {
   get toldDirty(): ReadonlyMap<string, boolean> {
      return this.dirtyStates;
   }
}

interface Harness {
   readonly connection: InspectableConnection;
   /** The connection's client. */
   readonly events: DataEvents<ProbeElement>;
   readonly calls: ServerCall[];
   readonly port: FakeDataPort;
   /** Drop the current transport, as a host does when its connection dies. */
   dropTransport(): void;
   /** Send the client a dirty flip over the current transport, as a server does. */
   notifyDirty(uri: string, dirty: boolean): Promise<void>;
   dispose(): void;
}

function harness(behaviour: ServerBehaviour = {}, boundMs?: number, events = new DataEvents<ProbeElement>()): Harness {
   const calls: ServerCall[] = [];
   const pairs: ReturnType<typeof makeDuplexConnectionPair>[] = [];
   const port = makeFakeDataPort({
      connect: () => {
         const pair = makeDuplexConnectionPair();
         pairs.push(pair);
         recordingServer(pair.left, calls, behaviour);
         return pair.right;
      }
   });
   const connection = new InspectableConnection(port, events, {
      sessionFactory: boundMs === undefined ? undefined : (clientId, host, label) => new BoundedSession(clientId, host, label, boundMs)
   });
   return {
      connection,
      events,
      calls,
      port,
      dropTransport: () => {
         port.fireDispose();
         pairs.at(-1)?.dispose();
      },
      notifyDirty: (uri, dirty) => pairs.at(-1)!.left.sendNotification(`${DATA_SERVER_WIRE_PREFIX}onDocumentDirtyChanged`, { uri, dirty }),
      dispose: () => {
         connection.dispose();
         pairs.forEach(pair => pair.dispose());
      }
   };
}

/** A session with a short in-flight bound, handed out through `sessionFactory`. */
class BoundedSession extends DataSession<ProbeElement> {
   protected override readonly settleBeforeCloseMs: number;

   constructor(clientId: string, host: DataSessionHost<ProbeElement, DataServerProtocol<ProbeElement>>, label: string, boundMs: number) {
      super(clientId, host, label);
      this.settleBeforeCloseMs = boundMs;
   }

   /** The server's URI the session keeps per URI it has open. */
   get serverUrisKept(): ReadonlyMap<string, string> {
      return this.serverUris;
   }
}

/** The server's URIs `session`, a {@link BoundedSession}, keeps. */
function serverUrisOf(session: DataSession<ProbeElement>): ReadonlyMap<string, string> {
   if (!(session instanceof BoundedSession)) {
      throw new Error('not a BoundedSession');
   }
   return session.serverUrisKept;
}

const of = (calls: readonly ServerCall[], ...methods: Method[]): ServerCall[] => calls.filter(call => methods.includes(call.method));

describe('DataConnection lifecycle hooks', () => {
   it('reports connecting then ready around the two waits', async () => {
      const pair = makeDuplexConnectionPair();
      recordingServer(pair.left, [], {});
      const port = makeFakeDataPort({ connect: () => pair.right });
      const steps: string[] = [];
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>(), {
         onConnecting: () => steps.push('connecting'),
         onReady: () => steps.push('ready'),
         onFailed: () => steps.push('failed')
      });
      try {
         await connection.createSession('panel').openDocument({ uri: URI_A });
         expect(steps).toEqual(['connecting', 'ready']);
      } finally {
         connection.dispose();
         pair.dispose();
      }
   });

   it('reports a failure instead of readiness when the transport never opens', async () => {
      const steps: string[] = [];
      const port = makeFakeDataPort({ connect: () => Promise.reject(new Error('no transport')) });
      const connection = new DataConnection<ProbeElement>(port, new DataEvents<ProbeElement>(), {
         onConnecting: () => steps.push('connecting'),
         onReady: () => steps.push('ready'),
         onFailed: () => steps.push('failed')
      });
      try {
         await expect(connection.connected()).rejects.toThrow('no transport');
         expect(steps).toEqual(['connecting', 'failed']);
      } finally {
         connection.dispose();
      }
   });
});

describe('DataConnection.createSession', () => {
   it('mints label#uuid by default and takes a fixed id as given', () => {
      const { connection, dispose } = harness();
      try {
         const first = connection.createSession('panel');
         const second = connection.createSession('panel');
         const fixed = connection.createSession('tree', 'tree-1');

         expect(first.clientId).toMatch(/^panel#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
         expect(second.clientId).not.toBe(first.clientId);
         expect(first.label).toBe('panel');
         expect(fixed.clientId).toBe('tree-1');
         expect(connection.createSession().clientId).toMatch(/^session#/);
      } finally {
         dispose();
      }
   });

   it('registers each session on the wire, and queues its calls behind the registration', async () => {
      const registration = gate();
      const { connection, calls, dispose } = harness({ createGate: registration.promise });
      try {
         const panel = connection.createSession('panel', 'panel');
         const tree = connection.createSession('tree', 'tree');
         const opening = panel.openDocument({ uri: URI_A });
         const writing = tree.updateDocument({ uri: URI_B, model: MODEL, basedOn: 'anything' });
         await waitFor(() => of(calls, 'createSession').length === 2);
         await tick(5);

         expect(of(calls, 'open', 'update')).toEqual([]);
         registration.release();
         await Promise.all([opening, writing]);

         const order = calls.map(call => `${call.method}:${call.clientId}`);
         expect(order.slice(0, 2)).toEqual(['createSession:panel', 'createSession:tree']);
         expect([...order.slice(2)].sort()).toEqual(['open:panel', 'update:tree', 'watch:panel']);
      } finally {
         registration.release();
         dispose();
      }
   });

   it('fails every call of a session the server refused to register', async () => {
      const { connection, dispose } = harness({ refuseSessions: true });
      try {
         const panel = connection.createSession('panel', 'panel');

         const rejection = await panel.openDocument({ uri: URI_A }).then(
            () => undefined,
            (error: unknown) => error
         );

         expect(isDuplicateClientIdError(rejection)).toBe(true);
         await expect(panel.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' })).rejects.toBeInstanceOf(ResponseError);
      } finally {
         dispose();
      }
   });

   it('refuses a clientId the framework reserves for its own broadcasts', () => {
      const { connection, dispose } = harness();
      try {
         // A session under one of these would match the framework's OWN
         // broadcasts as its own echoes and drop them. Every reserved id is
         // checked, since the guard is a list membership and a single case
         // passes for a hardcoded comparison against that one value.
         for (const reserved of FRAMEWORK_CLIENT_IDS) {
            expect(() => connection.createSession('panel', reserved)).toThrow(reserved);
         }
      } finally {
         dispose();
      }
   });

   it('refuses a clientId a live participant already holds, and frees it again on dispose', () => {
      const { connection, dispose } = harness();
      try {
         const first = connection.createSession('form', 'form-editor');

         expect(() => connection.createSession('form', 'form-editor')).toThrow('form-editor');
         expect(() => connection.createSession('tree', 'tree')).not.toThrow();

         first.dispose();
         expect(() => connection.createSession('form', 'form-editor')).not.toThrow();
      } finally {
         dispose();
      }
   });
});

describe('DataConnection.onDidCreateSession', () => {
   it('announces each session before createSession returns it, once the connection can let it go', () => {
      const { connection, dispose } = harness();
      try {
         const announced: DataSession<ProbeElement>[] = [];
         connection.onDidCreateSession(session => {
            announced.push(session);
            // Ended by the first listener to see it: the connection's own
            // removal must already be subscribed, or the id stays taken.
            if (session.label === 'brief') {
               session.dispose();
            }
         });

         const panel = connection.createSession('panel', 'panel');
         const brief = connection.createSession('brief', 'brief');

         expect(announced).toEqual([panel, brief]);
         expect([panel.isDisposed, brief.isDisposed]).toEqual([false, true]);
         expect(connection.liveSessions).toEqual([panel]);
         expect(() => connection.createSession('brief', 'brief')).not.toThrow();
      } finally {
         dispose();
      }
   });

   it('lists the sessions started before a listener subscribed', () => {
      const { connection, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         const tree = connection.createSession('tree', 'tree');
         tree.dispose();

         expect(connection.liveSessions).toEqual([panel]);
      } finally {
         dispose();
      }
   });
});

describe('DataConnection sessions', () => {
   it('stamps each session its own clientId on the wire', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         const tree = connection.createSession('tree', 'tree');

         await panel.openDocument({ uri: URI_A });
         await tree.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });

         expect(of(calls, 'open', 'update').map(call => call.clientId)).toEqual(['panel', 'tree']);
      } finally {
         dispose();
      }
   });

   it('recognises only its own echo', () => {
      const { connection, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         const tree = connection.createSession('tree', 'tree');

         expect(panel.isOwnEcho('panel')).toBe(true);
         expect(panel.isOwnEcho('tree')).toBe(false);
         expect(tree.isOwnEcho('tree')).toBe(true);
      } finally {
         dispose();
      }
   });

   it('ends only the disposing session on the server, and leaves the connection usable', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         const tree = connection.createSession('tree', 'tree');
         await panel.openDocument({ uri: URI_A });
         await tree.openDocument({ uri: URI_B });

         panel.dispose();
         await waitFor(() => of(calls, 'closeSession').length > 0);
         await tree.openDocument({ uri: URI_C });

         // One session close, and no per-document close: ending the session is
         // what closes its documents on the server.
         expect(of(calls, 'closeSession', 'close')).toEqual([{ method: 'closeSession', clientId: 'panel' }]);
         await expect(panel.openDocument({ uri: URI_C })).rejects.toSatisfy(isSessionClosedError);
      } finally {
         dispose();
      }
   });

   it('detaches its sessions on dispose rather than closing over a dying wire', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });

         connection.dispose();
         await tick(5);

         expect(of(calls, 'closeSession', 'close')).toEqual([]);
         await expect(panel.openDocument({ uri: URI_C })).rejects.toSatisfy(isSessionClosedError);
      } finally {
         dispose();
      }
   });

   it('closes a document only once the session’s update of it has answered', async () => {
      const update = gate();
      const { connection, calls, dispose } = harness({ updateGate: update.promise });
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         const writing = panel.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         const closing = panel.closeDocument({ uri: URI_A });
         await waitFor(() => of(calls, 'update').length === 1);
         await tick(5);

         expect(of(calls, 'close')).toEqual([]);
         update.release();
         await Promise.all([writing, closing]);

         expect(of(calls, 'update', 'close').map(call => call.method)).toEqual(['update', 'close']);
      } finally {
         update.release();
         dispose();
      }
   });

   it('ends the session only once its save has answered', async () => {
      const save = gate();
      const { connection, calls, dispose } = harness({ saveGate: save.promise });
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         const saving = panel.saveDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         await waitFor(() => of(calls, 'save').length === 1);

         panel.dispose();
         await tick(5);

         expect(of(calls, 'closeSession')).toEqual([]);
         save.release();
         await saving;
         await waitFor(() => of(calls, 'closeSession').length === 1, { message: 'the session was never ended' });
      } finally {
         save.release();
         dispose();
      }
   });

   it('ends the session after the bound when a save never answers, through a session the factory built', async () => {
      const save = gate();
      const { connection, calls, dispose } = harness({ saveGate: save.promise }, 30);
      try {
         const panel = connection.createSession('panel', 'panel');
         expect(panel).toBeInstanceOf(BoundedSession);
         await panel.openDocument({ uri: URI_A });
         void panel.saveDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' }).catch(() => undefined);
         await waitFor(() => of(calls, 'save').length === 1);

         panel.dispose();

         await waitFor(() => of(calls, 'closeSession').length === 1, { message: 'the bound never released the close' });
      } finally {
         save.release();
         dispose();
      }
   });

   it('never registers a session disposed before its registration was sent', async () => {
      const ready = gate();
      const { connection, calls, dispose } = harness({ readyGate: ready.promise });
      try {
         const panel = connection.createSession('panel', 'panel');

         panel.dispose();
         ready.release();
         await connection.connected();
         await tick(5);

         expect(of(calls, 'createSession', 'closeSession')).toEqual([]);
      } finally {
         ready.release();
         dispose();
      }
   });

   it('withOpenDocument leaves open a document an open of the session is still making', async () => {
      const opening = gate();
      const behaviour: ServerBehaviour = { openGate: opening.promise };
      const { connection, calls, dispose } = harness(behaviour);
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.connected();
         const plain = panel.openDocument({ uri: URI_A });
         await waitFor(() => of(calls, 'open').length === 1);

         const withOpen = panel.withOpenDocument({ uri: URI_A }, () => undefined);
         opening.release();
         await Promise.all([plain, withOpen]);

         expect(of(calls, 'close')).toEqual([]);
      } finally {
         opening.release();
         dispose();
      }
   });

   it('closes again a document whose watch failed, and rejects', async () => {
      const { connection, calls, dispose } = harness({ failWatch: true });
      try {
         const panel = connection.createSession('panel', 'panel');

         await expect(panel.openDocument({ uri: URI_A })).rejects.toThrow('watch refused');

         expect(of(calls, 'open', 'watch', 'close').map(call => call.method)).toEqual(['open', 'watch', 'close']);
      } finally {
         dispose();
      }
   });

   it('creates a document and watches it; writes a set in one call', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');

         await panel.createDocument({ uri: URI_A, text: '' });
         await panel.openDocument({ uri: URI_B });
         const written = await panel.updateDocuments({
            updates: [
               { uri: URI_A, model: MODEL, basedOn: 'anything' },
               { uri: URI_B, model: MODEL, basedOn: 'anything' }
            ]
         });

         expect(written.map(written => written.uri)).toEqual([URI_A, URI_B]);
         expect(of(calls, 'create', 'watch', 'updates').map(call => `${call.method}:${call.uri ?? ''}`)).toEqual([
            `create:${URI_A}`,
            `watch:${URI_A}`,
            `watch:${URI_B}`,
            'updates:'
         ]);
      } finally {
         dispose();
      }
   });

   it('withOpenDocument closes only an open it made', async () => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });

         const version = await panel.withOpenDocument({ uri: URI_B }, opened => opened.version);
         await panel.withOpenDocument({ uri: URI_A }, () => undefined);
         await expect(panel.withOpenDocument({ uri: URI_C }, () => Promise.reject(new Error('callback failed')))).rejects.toThrow(
            'callback failed'
         );

         expect(version).toBe(2);
         expect(of(calls, 'close').map(call => call.uri)).toEqual([URI_B, URI_C]);
      } finally {
         dispose();
      }
   });
});

describe('DataSession after a dropped connection', () => {
   it('restores a session with documents open at once, without a call of its own', async () => {
      const { connection, calls, dropTransport, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         const idle = connection.createSession('idle', 'idle');
         await panel.openDocument({ uri: URI_A });
         await idle.connected();
         const before = calls.length;

         dropTransport();

         await waitFor(() => of(calls.slice(before), 'watch').length === 1, { message: 'the open session never restored' });
         expect(calls.slice(before).map(call => `${call.method}:${call.clientId}`)).toEqual([
            'createSession:panel',
            'open:panel',
            'watch:panel'
         ]);
         // The restore reads the dirty state after the watch. A request still
         // queued when the harness tears the pair down fails its write outside
         // any caller, as an unhandled rejection.
         await panel.connected();
      } finally {
         dispose();
      }
   });

   it('reports once the documents whose unsaved write the re-opened version no longer holds, and sends nothing', async () => {
      const { connection, calls, port, dropTransport, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         await panel.openDocument({ uri: URI_B });
         await panel.openDocument({ uri: URI_C });
         await panel.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         await panel.updateDocument({ uri: URI_B, model: MODEL, basedOn: 'anything' });
         const before = calls.length;

         dropTransport();
         await panel.saveDocument({ uri: URI_C, model: MODEL, basedOn: 'anything' });

         // The re-opens answer v4 to v6 where the writes were answered v1: the
         // text changed while the session was gone, and nothing is sent to
         // put it back.
         expect(calls.slice(before).map(call => `${call.method}:${call.uri ?? ''}`)).toEqual([
            'createSession:',
            `open:${URI_A}`,
            `watch:${URI_A}`,
            `open:${URI_B}`,
            `watch:${URI_B}`,
            `open:${URI_C}`,
            `watch:${URI_C}`,
            `save:${URI_C}`
         ]);
         expect(port.reported.map(entry => entry.message.code)).toEqual([DATA_SESSION_UNSAVED_LOST.code]);
         expect(port.reported[0].message.params).toEqual({ uris: `${URI_A}, ${URI_B}` });

         // Reported once: the record is dropped, and the documents stay open.
         const again = calls.length;
         dropTransport();
         await panel.connected();
         expect(port.reported).toHaveLength(1);
         expect(of(calls.slice(again), 'open').map(call => call.uri)).toEqual([URI_A, URI_B, URI_C]);
      } finally {
         dispose();
      }
   });

   it('reports nothing for a write the re-opened document still holds', async () => {
      const { connection, calls, port, dropTransport, dispose } = harness({ versions: new Map([[URI_A, 5]]) });
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         await panel.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         const before = calls.length;

         dropTransport();
         await panel.connected();

         expect(calls.slice(before).map(call => call.method)).toEqual(['createSession', 'open', 'watch']);
         expect(port.reported).toEqual([]);
      } finally {
         dispose();
      }
   });

   it('reports nothing for a write a save or a close has settled', async () => {
      const { connection, port, dropTransport, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         await panel.openDocument({ uri: URI_B });
         await panel.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         await panel.saveDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         await panel.updateDocument({ uri: URI_B, model: MODEL, basedOn: 'anything' });
         await panel.closeDocument({ uri: URI_B });

         dropTransport();
         await panel.connected();

         expect(port.reported).toEqual([]);
      } finally {
         dispose();
      }
   });

   it('keeps the URI the last open of a document named until it closes, fails to re-open, or the session detaches', async () => {
      const behaviour: ServerBehaviour = { canonical: uri => `${uri}#served` };
      const { connection, dropTransport, dispose } = harness(behaviour, 10_000);
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         await panel.openDocument({ uri: URI_B });
         await panel.openDocument({ uri: URI_C });

         await panel.closeDocument({ uri: URI_A });
         expect([...serverUrisOf(panel)]).toEqual([
            [URI_B, `${URI_B}#served`],
            [URI_C, `${URI_C}#served`]
         ]);

         // The re-open names another URI, which replaces the first.
         behaviour.failOpens = new Set([URI_C]);
         behaviour.canonical = uri => `${uri}#moved`;
         dropTransport();
         await panel.connected();
         expect([...serverUrisOf(panel)]).toEqual([[URI_B, `${URI_B}#moved`]]);

         panel.detach();
         expect(serverUrisOf(panel).size).toBe(0);
      } finally {
         dispose();
      }
   });

   it('sends no session close over the dropped connection when disposed before it restored', async () => {
      const { connection, calls, dropTransport, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });

         dropTransport();
         panel.dispose();
         await tick(5);

         // The server ended the session when the connection dropped, and a fresh
         // connection just to end it again would register nothing to end.
         expect(of(calls, 'closeSession')).toEqual([]);
         expect(of(calls, 'createSession')).toHaveLength(1);
      } finally {
         dispose();
      }
   });
});

describe('DataConnection.reportError', () => {
   it('surfaces a failure through the port, for every participant', () => {
      const { connection, port, dispose } = harness();
      try {
         const failure = new Error('boom');
         const reported = { code: 'test/failed', text: 'boom', params: {} };

         connection.reportError(failure, reported);

         // Through the PORT, not swallowed and not a channel of its own: the
         // port is the host's one sink, so a panel and a tree on the same
         // connection report the same way without being handed the transport.
         expect(port.reported).toEqual([{ error: failure, message: reported }]);
      } finally {
         dispose();
      }
   });
});

describe('DataConnectionWithEvents', () => {
   function eventsHarness(): { connection: DataConnectionWithEvents<ProbeElement>; notify: (uri: string) => void; dispose(): void } {
      const pair = makeDuplexConnectionPair();
      recordingServer(pair.left, [], {});
      const fakePort = makeFakeDataPort({ connect: () => pair.right });
      const connection = new DataConnectionWithEvents<ProbeElement>(fakePort);
      return {
         connection,
         notify: (uri: string) =>
            void pair.left
               .sendNotification(`${DATA_SERVER_WIRE_PREFIX}onDocumentUpdated`, {
                  document: document(uri),
                  sourceClientId: 'panel',
                  reason: 'changed'
               })
               .catch(() => undefined),
         dispose: () => {
            connection.dispose();
            pair.dispose();
         }
      };
   }

   it('fans one server push out to every listener', async () => {
      const { connection, notify, dispose } = eventsHarness();
      try {
         // A connection binds exactly ONE client, and a method name maps to one
         // handler — a second registration replaces the first silently. So
         // without the fan-out only the first interested party could ever hear
         // the server, and two listeners is the smallest case that tells
         // fan-out from plain delivery.
         const seen: string[] = [];
         connection.events.onDidUpdateDocument(event => seen.push(`first:${event.document.uri}`));
         connection.events.onDidUpdateDocument(event => seen.push(`second:${event.document.uri}`));
         // The generation, and with it the inbound binding, is built lazily on
         // first use — nothing is bound until something asks.
         await connection.connected();

         notify(URI_A);
         await waitFor(() => seen.length >= 2);

         expect(seen).toEqual([`first:${URI_A}`, `second:${URI_A}`]);
      } finally {
         dispose();
      }
   });

   it('disposes the fan-out it created', async () => {
      const { connection, dispose } = eventsHarness();
      try {
         const seen: string[] = [];
         connection.events.onDidUpdateDocument(() => seen.push('heard'));
         await connection.connected();

         connection.dispose();
         // Driven through the WIRE method rather than the server: disposing the
         // connection already kills the transport, so a real push reaches
         // nothing whether or not the emitters were torn down — the absence
         // would hold in both states and witness neither.
         connection.events.onDocumentUpdated({ document: document(URI_A), sourceClientId: 'panel', reason: 'changed' } as never);

         expect(seen).toEqual([]);
      } finally {
         dispose();
      }
   });
});

describe('DataSession disposal', () => {
   // `closes`: whether the session's end reaches the server, awaited so the
   // teardown does not cut off the server's answer. A detach sends nothing.
   it.each([
      ['dispose', ['dispose'], 1],
      ['detach', ['detach'], 0],
      ['dispose, then detach', ['dispose', 'detach'], 0],
      ['detach, then dispose', ['detach', 'dispose'], 0],
      ['dispose twice', ['dispose', 'dispose'], 1],
      ['detach twice', ['detach', 'detach'], 0]
   ] as const)('fires onDidDispose once for %s', async (_name, steps, closes) => {
      const { connection, calls, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.connected();
         let fired = 0;
         panel.onDidDispose(() => fired++);

         for (const step of steps) {
            panel[step]();
         }

         expect(fired).toBe(1);
         // The close crosses the wire, so a loaded event loop can take longer
         // than any fixed yield to deliver it; the yield after serves the
         // negative, a second close or one a detach should have cancelled.
         await waitFor(() => of(calls, 'closeSession').length >= closes);
         await tick(5);
         expect(of(calls, 'closeSession')).toHaveLength(closes);
      } finally {
         dispose();
      }
   });

   it('fires onDidDispose for every session when the connection is disposed', async () => {
      const { connection, dispose } = harness();
      const panel = connection.createSession('panel', 'panel');
      const tree = connection.createSession('tree', 'tree');
      await Promise.all([panel.connected(), tree.connected()]);
      const fired: string[] = [];
      panel.onDidDispose(() => fired.push('panel'));
      tree.onDidDispose(() => fired.push('tree'));

      dispose();

      expect(fired).toEqual(['panel', 'tree']);
   });

   it('frees the id on the connection before any other listener runs, so a listener can start a session under it there', async () => {
      // The connection's claim only: a real server still holds the id until the
      // old session's close arrives, and this harness's server refuses nothing.
      const { connection, dispose } = harness();
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.connected();
         const successors: DataSession<ProbeElement>[] = [];
         panel.onDidDispose(() => successors.push(connection.createSession('panel', 'panel')));

         panel.dispose();

         expect(successors.map(successor => successor.clientId)).toEqual(['panel']);
         expect(connection.liveSessions).toEqual(successors);
      } finally {
         dispose();
      }
   });

   it('frees the id even when a listener throws', async () => {
      const { connection, calls, dispose } = harness();
      // vscode-jsonrpc's emitter reports a throwing listener on the console and
      // carries on; silenced so the run stays readable, and asserted so the
      // isolation this relies on is pinned rather than assumed.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.connected();
         panel.onDidDispose(() => {
            throw new Error('listener failed');
         });

         expect(() => panel.dispose()).not.toThrow();

         expect(consoleError).toHaveBeenCalled();
         await connection.createSession('panel', 'panel').connected();
         await waitFor(() => of(calls, 'closeSession').length === 1);
      } finally {
         consoleError.mockRestore();
         dispose();
      }
   });

   it('reports a save in flight until it answers', async () => {
      const save = gate();
      const { connection, dispose } = harness({ saveGate: save.promise });
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         expect(panel.hasSavesInFlight).toBe(false);

         const saving = panel.saveDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });
         expect(panel.hasSavesInFlight).toBe(true);
         let settled = false;
         const waiting = panel.whenSavesSettled().then(() => (settled = true));
         await tick(5);
         expect(settled).toBe(false);

         save.release();
         await Promise.all([saving, waiting]);
         expect(panel.hasSavesInFlight).toBe(false);
      } finally {
         save.release();
         dispose();
      }
   });

   it('counts an update in flight as no save', async () => {
      const update = gate();
      const { connection, dispose } = harness({ updateGate: update.promise });
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });

         const writing = panel.updateDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' });

         expect(panel.hasSavesInFlight).toBe(false);
         update.release();
         await writing;
      } finally {
         update.release();
         dispose();
      }
   });

   it('stops waiting for a save that never answers after the bound', async () => {
      const save = gate();
      const { connection, dispose } = harness({ saveGate: save.promise }, 30);
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         void panel.saveDocument({ uri: URI_A, model: MODEL, basedOn: 'anything' }).catch(() => undefined);

         await panel.whenSavesSettled();

         expect(panel.hasSavesInFlight).toBe(true);
         // Answered before the pair goes, so the server's reply has a stream to land on.
         save.release();
         await waitFor(() => !panel.hasSavesInFlight);
      } finally {
         save.release();
         dispose();
      }
   });
});

describe('DataSession restore and the dirty state', () => {
   /** The dirty flips `events` delivers, as `uri dirty`. */
   function dirtyFlips(events: DataEvents<ProbeElement>): string[] {
      const flips: string[] = [];
      events.onDidChangeDocumentDirty(event => flips.push(`${event.uri} ${event.dirty}`));
      return flips;
   }

   it('tells the client of a flip made while the connection was down', async () => {
      const behaviour: ServerBehaviour = { dirty: new Map([[URI_A, false]]) };
      const { connection, events, notifyDirty, dropTransport, dispose } = harness(behaviour);
      try {
         const flips = dirtyFlips(events);
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         behaviour.dirty!.set(URI_A, true);
         await notifyDirty(URI_A, true);
         await waitFor(() => flips.length === 1);

         // The server reverted the document when the connection dropped, and
         // no one on the connection heard it.
         behaviour.dirty!.set(URI_A, false);
         dropTransport();
         await panel.connected();

         expect(flips).toEqual([`${URI_A} true`, `${URI_A} false`]);
      } finally {
         dispose();
      }
   });

   it('tells the client of a flip between the re-open and the watch', async () => {
      const behaviour: ServerBehaviour = { dirty: new Map([[URI_A, false]]) };
      const { connection, events, notifyDirty, dropTransport, dispose } = harness(behaviour);
      try {
         const flips = dirtyFlips(events);
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         behaviour.dirty!.set(URI_A, true);
         await notifyDirty(URI_A, true);
         behaviour.dirty!.set(URI_A, false);
         await notifyDirty(URI_A, false);
         await waitFor(() => flips.length === 2);

         // The re-open answers clean, and an edit lands before the watch, so
         // no notification reports it.
         behaviour.beforeWatch = uri => behaviour.dirty!.set(uri, true);
         dropTransport();
         await panel.connected();

         expect(flips).toEqual([`${URI_A} true`, `${URI_A} false`, `${URI_A} true`]);
      } finally {
         dispose();
      }
   });

   it('tells the client nothing when the restored answer is the last it was told', async () => {
      const behaviour: ServerBehaviour = { dirty: new Map([[URI_A, false]]) };
      const { connection, events, notifyDirty, dropTransport, dispose } = harness(behaviour);
      try {
         const flips = dirtyFlips(events);
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         behaviour.dirty!.set(URI_A, true);
         await notifyDirty(URI_A, true);
         await waitFor(() => flips.length === 1);

         dropTransport();
         await panel.connected();
         await tick();

         expect(flips).toEqual([`${URI_A} true`]);
      } finally {
         dispose();
      }
   });

   it('tells the client the restored answer when nothing reached it since its last open', async () => {
      // The client last heard dirty before the close; the open after it
      // answered clean to its caller alone, so what it heard says nothing now.
      const behaviour: ServerBehaviour = { dirty: new Map([[URI_A, false]]) };
      const { connection, events, notifyDirty, dropTransport, dispose } = harness(behaviour);
      try {
         const flips = dirtyFlips(events);
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         behaviour.dirty!.set(URI_A, true);
         await notifyDirty(URI_A, true);
         await waitFor(() => flips.length === 1);
         await panel.closeDocument({ uri: URI_A });
         behaviour.dirty!.set(URI_A, false);
         await panel.openDocument({ uri: URI_A });

         behaviour.dirty!.set(URI_A, true);
         dropTransport();
         await panel.connected();

         expect(flips).toEqual([`${URI_A} true`, `${URI_A} true`]);
      } finally {
         dispose();
      }
   });

   it('forgets what the client was told of a document once it closes', async () => {
      const behaviour: ServerBehaviour = { dirty: new Map([[URI_A, false]]) };
      const { connection, notifyDirty, dispose } = harness(behaviour);
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         await notifyDirty(URI_A, true);
         await waitFor(() => connection.toldDirty.has(URI_A));

         await panel.closeDocument({ uri: URI_A });

         expect(connection.toldDirty.has(URI_A)).toBe(false);
      } finally {
         dispose();
      }
   });

   it('forgets what the client was told of a document closed under another spelling of its URI', async () => {
      const spelled = 'file:///C:/ws/a.x';
      const canonical = 'file:///c%3A/ws/a.x';
      const behaviour: ServerBehaviour = {
         dirty: new Map([[canonical, true]]),
         canonical: uri => (uri === spelled ? canonical : uri)
      };
      const { connection, events, notifyDirty, dropTransport, dispose } = harness(behaviour);
      try {
         const flips = dirtyFlips(events);
         const panel = connection.createSession('panel', 'panel');
         const other = connection.createSession('other', 'other');
         await other.openDocument({ uri: canonical });
         await panel.openDocument({ uri: spelled });
         await notifyDirty(canonical, true);
         await waitFor(() => flips.length === 1);

         await panel.closeDocument({ uri: spelled });
         expect(connection.toldDirty.has(canonical)).toBe(false);

         // A close leaves nothing to restore, so the other session's restore
         // tells the client the state again.
         dropTransport();
         await other.connected();
         expect(flips).toEqual([`${canonical} true`, `${canonical} true`]);
      } finally {
         dispose();
      }
   });

   it('keeps a document restored whose dirty state the client throws on', async () => {
      const behaviour: ServerBehaviour = { dirty: new Map([[URI_A, true]]) };
      const events = new DataEvents<ProbeElement>();
      events.onDocumentDirtyChanged = () => {
         throw new Error('listener failed');
      };
      const { connection, calls, dropTransport, dispose } = harness(behaviour, undefined, events);
      try {
         const panel = connection.createSession('panel', 'panel');
         await panel.openDocument({ uri: URI_A });
         dropTransport();
         await panel.connected();
         await waitFor(() => of(calls, 'open').length === 2);

         // Still open: the next reconnect re-opens it once more.
         dropTransport();
         await panel.connected();
         await waitFor(() => of(calls, 'open').length === 3);
      } finally {
         dispose();
      }
   });
});
