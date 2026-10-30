/********************************************************************************
 * Copyright (c) 2026 CrossBreeze, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc';
import {
   CONFLICT_ERROR_CODE,
   ConflictError,
   DOCUMENT_NOT_OPEN,
   DOCUMENT_NOT_OPEN_ERROR_CODE,
   DUPLICATE_CLIENT_ID,
   DUPLICATE_CLIENT_ID_ERROR_CODE,
   DocumentNotOpenError,
   DuplicateClientIdError,
   HYDRANIUM_ERROR_CODES,
   RESERVED_CLIENT_ID_ERROR_CODE,
   ReservedClientIdError,
   SAVE_FAILED,
   SAVE_FAILED_ERROR_CODE,
   SESSION_CLOSED,
   SESSION_CLOSED_ERROR_CODE,
   STALE_BASE_VERSION_UPDATE,
   SaveFailedError,
   SessionClosedError,
   DOCUMENT_SYNTAX_ERROR,
   DOCUMENT_SYNTAX_ERROR_CODE,
   DocumentSyntaxError,
   isConflictError,
   isDocumentNotOpenError,
   isDuplicateClientIdError,
   isReservedClientIdError,
   isResponseError,
   isSaveFailedError,
   isSessionClosedError,
   isDocumentSyntaxError,
   reviveProtocolError,
   reviveProtocolErrorJson
} from '../src/errors';
import { hasMessageIdentity, resolvedFromResponseError } from '../src/messages/primitives';
import { asModelVersion } from '../src/model-service/base-version';

/** A `ResponseError` as another copy of `vscode-jsonrpc` builds it: the same shape, another class. */
class ForeignResponseError extends Error {
   constructor(
      readonly code: number,
      message: string,
      readonly data?: unknown
   ) {
      super(message);
   }

   toJson(): { code: number; message: string; data?: unknown } {
      return { code: this.code, message: this.message, data: this.data };
   }
}

describe('isResponseError', () => {
   it('recognises a ResponseError from this copy and from another', () => {
      expect(isResponseError(new ResponseError(4242, 'Ours.'))).toBe(true);
      expect(isResponseError(new ForeignResponseError(4242, 'Another copy.'))).toBe(true);
   });

   it('rejects an error whose code is not an integer, or that has no toJson', () => {
      expect(isResponseError(Object.assign(new Error('Not found.'), { code: 'ENOENT' }))).toBe(false);
      expect(isResponseError(Object.assign(new Error('Half.'), { code: 1.5, toJson: () => ({}) }))).toBe(false);
      expect(isResponseError(Object.assign(new Error('Status.'), { code: 404 }))).toBe(false);
      expect(isResponseError({ code: 4242, message: 'Not an error.', toJson: () => ({}) })).toBe(false);
   });
});

describe('reviveProtocolError', () => {
   it('revives a typed error that arrived through another copy of vscode-jsonrpc', () => {
      const arrived = new ForeignResponseError(DUPLICATE_CLIENT_ID_ERROR_CODE, 'Taken.', { clientId: 'client-1' });
      const revived = reviveProtocolError(arrived);
      expect(revived).toBeInstanceOf(DuplicateClientIdError);
      expect(revived).toMatchObject({ clientId: 'client-1', message: 'Taken.' });
   });
});

describe('reviveProtocolErrorJson', () => {
   it('revives a typed error from its JSON-RPC envelope', () => {
      const revived = reviveProtocolErrorJson(JSON.stringify(new DuplicateClientIdError('client-1').toJson()));
      expect(revived).toBeInstanceOf(DuplicateClientIdError);
      expect(revived).toMatchObject({ clientId: 'client-1' });
   });

   it('answers a plain ResponseError for a code no typed error claims', () => {
      const revived = reviveProtocolErrorJson('{"code":4242,"message":"Elsewhere.","data":{"detail":1}}');
      expect(revived).toBeInstanceOf(ResponseError);
      expect(revived).toMatchObject({ code: 4242, message: 'Elsewhere.', data: { detail: 1 } });
   });

   it('answers undefined for text that is not an envelope', () => {
      expect(reviveProtocolErrorJson('Error: plain failure')).toBeUndefined();
      expect(reviveProtocolErrorJson('"a string"')).toBeUndefined();
      expect(reviveProtocolErrorJson('{"code":1.5,"message":"Half."}')).toBeUndefined();
      expect(reviveProtocolErrorJson('{"code":4242}')).toBeUndefined();
   });
});

describe('ConflictError', () => {
   it('exposes uri / baseVersion / actualVersion via getters backed by the data payload', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect(error.uri).toBe('file:///A.fake');
      expect(error.baseVersion).toBe(3);
      expect(error.actualVersion).toBe(5);
   });

   it('carries neither `expected` nor `actual`, which a test reporter would read as an assertion failure', () => {
      // vitest's formatter enters its diff branch for any error defining both,
      // then assigns the prettified values back — throwing on an accessor and
      // replacing the real failure with a TypeError. The two reads below ARE
      // that branch's condition.
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect('expected' in error).toBe(false);
      expect('actual' in error).toBe(false);
   });

   it('carries the typed data payload on the JSON-RPC error envelope', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      // `toMatchObject`, not `toEqual`: `data` also carries the message identity,
      // and asserting the payload EXACTLY would make every future envelope field
      // a test change. The identity's own assertion is the next case.
      expect(error.data).toMatchObject({ uri: 'file:///A.fake', baseVersion: 3, actualVersion: 5 });
   });

   it('carries the message identity beside the typed payload, so a translating host can render it', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect(hasMessageIdentity(error.data)).toBe(true);
      expect(resolvedFromResponseError(error)?.code).toBe(STALE_BASE_VERSION_UPDATE.code);
      // The uri only: the versions stay in `data`, so no translation can put
      // them back into the sentence.
      expect(resolvedFromResponseError(error)?.params).toEqual({ uri: 'file:///A.fake' });
   });

   it('sets the application-specific JSON-RPC code', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect(error.code).toBe(CONFLICT_ERROR_CODE);
   });

   it('builds a message that names the URI and words the versions', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect(error.message).toContain('file:///A.fake');
      expect(error.message).not.toMatch(/\d/);
   });

   it('has name "ConflictError" so direct-throw detection works without instanceof', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect(error.name).toBe('ConflictError');
   });

   it('is a ResponseError subclass, so it survives JSON-RPC reconstruction', () => {
      const error = new ConflictError('file:///A.fake', asModelVersion(3), 5);
      expect(error).toBeInstanceOf(ResponseError);
   });
});

describe('HYDRANIUM_ERROR_CODES', () => {
   const codes = Object.values(HYDRANIUM_ERROR_CODES);

   it('gives every framework error a distinct code', () => {
      expect(new Set(codes).size).toBe(codes.length);
   });

   it('keeps every code inside the block the framework reserves', () => {
      expect(codes.filter(code => code < 42000 || code > 42999)).toEqual([]);
   });

   it('holds the code of every error this package defines', () => {
      const defined = [
         CONFLICT_ERROR_CODE,
         SESSION_CLOSED_ERROR_CODE,
         DOCUMENT_NOT_OPEN_ERROR_CODE,
         DUPLICATE_CLIENT_ID_ERROR_CODE,
         RESERVED_CLIENT_ID_ERROR_CODE,
         SAVE_FAILED_ERROR_CODE,
         DOCUMENT_SYNTAX_ERROR_CODE
      ];
      expect(defined.filter(code => !codes.includes(code))).toEqual([]);
   });
});

const FAILURES = [
   { uri: 'file:///a.x', reason: 'EACCES: permission denied' },
   { uri: 'file:///a.layout', reason: 'ENOSPC: no space left on device' }
];

describe('client session errors', () => {
   const cases = [
      {
         name: 'SessionClosedError',
         make: () => new SessionClosedError('form#1'),
         code: SESSION_CLOSED_ERROR_CODE,
         guard: isSessionClosedError,
         data: { clientId: 'form#1' }
      },
      {
         name: 'DocumentNotOpenError',
         make: () => new DocumentNotOpenError('file:///a.x', 'form#1'),
         code: DOCUMENT_NOT_OPEN_ERROR_CODE,
         guard: isDocumentNotOpenError,
         data: { uri: 'file:///a.x', clientId: 'form#1' }
      },
      {
         name: 'DuplicateClientIdError',
         make: () => new DuplicateClientIdError('form#1'),
         code: DUPLICATE_CLIENT_ID_ERROR_CODE,
         guard: isDuplicateClientIdError,
         data: { clientId: 'form#1' }
      },
      {
         name: 'ReservedClientIdError',
         make: () => new ReservedClientIdError('integrity'),
         code: RESERVED_CLIENT_ID_ERROR_CODE,
         guard: isReservedClientIdError,
         data: { clientId: 'integrity' }
      },
      {
         name: 'SaveFailedError',
         make: () => new SaveFailedError(FAILURES),
         code: SAVE_FAILED_ERROR_CODE,
         guard: isSaveFailedError,
         data: { failures: FAILURES }
      },
      {
         name: 'DocumentSyntaxError',
         make: () => new DocumentSyntaxError('file:///a.x'),
         code: DOCUMENT_SYNTAX_ERROR_CODE,
         guard: isDocumentSyntaxError,
         data: { uri: 'file:///a.x' }
      }
   ] as const;

   for (const entry of cases) {
      it(`${entry.name} carries its code, name and fields on the JSON-RPC envelope`, () => {
         const error = entry.make();
         expect(error).toBeInstanceOf(ResponseError);
         expect(error.code).toBe(entry.code);
         expect(error.name).toBe(entry.name);
         // `toMatchObject`: an error with a message identity also carries it
         // in `data`, asserted on its own below.
         expect(error.data).toMatchObject(entry.data);
         for (const [field, value] of Object.entries(entry.data)) {
            expect((error as unknown as Record<string, unknown>)[field]).toBe(value);
         }
      });

      it(`${entry.name} is recognised in-process and once revived, and no other class is`, () => {
         expect(entry.guard(entry.make())).toBe(true);
         expect(entry.guard(reviveProtocolError(new ResponseError(entry.code, 'transport-wrapped', entry.data)))).toBe(true);
         expect(entry.guard(new ConflictError('file:///a.x', asModelVersion(1), 2))).toBe(false);
         for (const other of cases.filter(candidate => candidate !== entry)) {
            expect(entry.guard(other.make())).toBe(false);
         }
         expect(entry.guard(new Error('boom'))).toBe(false);
         expect(entry.guard(undefined)).toBe(false);
      });

      it(`${entry.name} is refused as a bare ResponseError, even named and holding its fields`, () => {
         // What a connection that does not revive holds after an RPC.
         const bare = new ResponseError(entry.code, 'transport-wrapped', entry.data);
         expect(entry.guard(bare)).toBe(false);
         Object.assign(bare, { name: entry.name }, entry.data);
         expect(entry.guard(bare)).toBe(false);
      });

      it(`${entry.name} is refused without its data, rather than throwing`, () => {
         for (const data of [null, undefined, {}]) {
            const error = entry.make();
            Object.assign(error, { data });
            expect(entry.guard(error)).toBe(false);
         }
      });

      it(`${entry.name} is recognised from another copy of this package, by its brand and getters`, () => {
         const error = otherCopyOf(entry.name, entry.code, entry.data, true);
         expect(entry.guard(error)).toBe(true);
         for (const [field, value] of Object.entries(entry.data)) {
            expect(Reflect.get(error, field)).toBe(value);
         }
         // The brand is public, so a class without the getters is refused.
         expect(entry.guard(otherCopyOf(entry.name, entry.code, entry.data, false))).toBe(false);
      });
   }
});

describe('SessionClosedError', () => {
   it('carries the message identity beside the client id, and keeps the id out of the sentence', () => {
      const error = new SessionClosedError('form#1');
      expect(resolvedFromResponseError(error)?.code).toBe(SESSION_CLOSED.code);
      expect(error.message).toBe(SESSION_CLOSED.text);
      expect(error.message).not.toContain('form#1');
      expect(error.clientId).toBe('form#1');
   });

   it('keeps the identity under a caller-supplied sentence', () => {
      const error = new SessionClosedError('form#1', 'The diagram has closed');
      expect(error.message).toBe('The diagram has closed');
      expect(resolvedFromResponseError(error)?.code).toBe(SESSION_CLOSED.code);
   });
});

describe('DocumentNotOpenError', () => {
   it('carries the message identity, and names the uri but not the client id', () => {
      const error = new DocumentNotOpenError('file:///a.x', 'form#1');
      expect(resolvedFromResponseError(error)?.code).toBe(DOCUMENT_NOT_OPEN.code);
      expect(resolvedFromResponseError(error)?.params).toEqual({ uri: 'file:///a.x' });
      expect(error.message).toBe(DOCUMENT_NOT_OPEN.format({ uri: 'file:///a.x' }));
      expect(error.message).not.toContain('form#1');
   });
});

describe('DuplicateClientIdError', () => {
   it('carries the message identity, and keeps the client id out of the sentence', () => {
      const error = new DuplicateClientIdError('form#1');
      expect(resolvedFromResponseError(error)?.code).toBe(DUPLICATE_CLIENT_ID.code);
      expect(error.message).toBe(DUPLICATE_CLIENT_ID.text);
      expect(error.message).not.toContain('form#1');
   });
});

describe('ReservedClientIdError', () => {
   it('carries no message identity, since no end-user sentence is true for a host that picked a reserved id', () => {
      const error = new ReservedClientIdError('integrity');
      expect(hasMessageIdentity(error.data)).toBe(false);
      expect(error.message).toContain('integrity');
   });
});

describe('DocumentSyntaxError', () => {
   it('carries the message identity, naming the uri', () => {
      const error = new DocumentSyntaxError('file:///a.x');
      expect(resolvedFromResponseError(error)?.code).toBe(DOCUMENT_SYNTAX_ERROR.code);
      expect(resolvedFromResponseError(error)?.params).toEqual({ uri: 'file:///a.x' });
      expect(error.message).toBe(DOCUMENT_SYNTAX_ERROR.format({ uri: 'file:///a.x' }));
   });
});

describe('isConflictError', () => {
   it('returns true for a ConflictError instance (direct throw)', () => {
      expect(isConflictError(new ConflictError('file:///A.fake', asModelVersion(3), 5))).toBe(true);
   });

   it('returns false for a plain Error named "ConflictError", which has none of its fields', () => {
      const cloned = new Error('boom');
      cloned.name = 'ConflictError';
      expect(isConflictError(cloned)).toBe(false);
   });

   it('returns false for a bare ResponseError carrying the conflict code, and true once it is revived', () => {
      const reconstructed = new ResponseError(CONFLICT_ERROR_CODE, 'some transport-wrapped message', {
         uri: 'file:///A.fake',
         baseVersion: 3,
         actualVersion: 5
      });
      expect(isConflictError(reconstructed)).toBe(false);
      expect(isConflictError(reviveProtocolError(reconstructed))).toBe(true);
   });

   it('returns false for a bare ResponseError named "ConflictError" and holding its fields', () => {
      const fields = { uri: 'file:///A.fake', baseVersion: 3, actualVersion: 5 };
      const bare = Object.assign(new ResponseError(CONFLICT_ERROR_CODE, 'renamed', fields), { name: 'ConflictError' }, fields);
      expect(isConflictError(bare)).toBe(false);
   });

   it('returns false for a ConflictError without its data, rather than throwing', () => {
      for (const data of [null, undefined, {}]) {
         expect(isConflictError(Object.assign(new ConflictError('file:///A.fake', asModelVersion(3), 5), { data }))).toBe(false);
      }
   });

   it('returns true for a subclass that names itself', () => {
      class EditorConflict extends ConflictError {
         constructor() {
            super('file:///A.fake', asModelVersion(3), 5);
            this.name = 'EditorConflict';
         }
      }
      expect(isConflictError(new EditorConflict())).toBe(true);
   });

   it('returns true for one from another copy of this package with its getters, and false without them', () => {
      const fields = { uri: 'file:///A.fake', baseVersion: 3, actualVersion: 5 };
      const error = otherCopyOf('ConflictError', CONFLICT_ERROR_CODE, fields, true);
      expect(isConflictError(error) && [error.uri, error.baseVersion, error.actualVersion]).toEqual([fields.uri, 3, 5]);
      expect(isConflictError(otherCopyOf('ConflictError', CONFLICT_ERROR_CODE, fields, false))).toBe(false);
   });

   it('returns false for a plain Error that only words a conflict', () => {
      const wrapped = new Error(`Request ns/save failed: ${STALE_BASE_VERSION_UPDATE.format({ uri: 'file:///A' })}`);
      expect(isConflictError(wrapped)).toBe(false);
   });

   it('returns false for a plain Error', () => {
      expect(isConflictError(new Error('boom'))).toBe(false);
   });

   it('returns false for a ResponseError with a different code', () => {
      expect(isConflictError(new ResponseError(-32603, 'internal error'))).toBe(false);
   });

   it('returns false for non-Error values', () => {
      expect(isConflictError(undefined)).toBe(false);
      expect(isConflictError(null)).toBe(false);
      expect(isConflictError('ConflictError')).toBe(false);
      expect(isConflictError({ name: 'ConflictError' })).toBe(false);
   });
});

describe('SaveFailedError', () => {
   it('names every document with its reason, in its message and its identity', () => {
      const error = new SaveFailedError(FAILURES);
      expect(error.message).toBe(
         'Could not save file:///a.x (EACCES: permission denied), file:///a.layout (ENOSPC: no space left on device).'
      );
      expect(resolvedFromResponseError(error)?.code).toBe(SAVE_FAILED.code);
      expect(resolvedFromResponseError(error)?.params).toEqual({
         failures: 'file:///a.x (EACCES: permission denied), file:///a.layout (ENOSPC: no space left on device)'
      });
   });

   it('is revived with its failures from the JSON-RPC envelope', () => {
      const { code, message, data } = new SaveFailedError(FAILURES).toJson();
      const revived = reviveProtocolError(new ResponseError(code, message, data));
      expect(revived).toBeInstanceOf(SaveFailedError);
      expect(revived).toMatchObject({ failures: FAILURES, message });
   });

   it('is not revived from failures that lack a uri or a reason', () => {
      const arrived = new ResponseError(SAVE_FAILED_ERROR_CODE, 'Could not save.', { failures: [{ uri: 'file:///a.x' }] });
      expect(reviveProtocolError(arrived)).toBe(arrived);
   });
});

/** A typed error as another copy of this package builds it: branded as `name`, with or without the getters reading `data`. */
function otherCopyOf(name: string, code: number, data: Record<string, unknown>, withGetters: boolean): ResponseError<unknown> {
   class OtherCopy extends ResponseError<unknown> {
      constructor() {
         super(code, 'from another copy', data);
         // As each class here restores what `ResponseError` resets.
         Object.setPrototypeOf(this, OtherCopy.prototype);
      }
   }
   Object.defineProperty(OtherCopy.prototype, Symbol.for(`hydranium/protocol/${name}`), { value: true });
   if (withGetters) {
      for (const field of Object.keys(data)) {
         Object.defineProperty(OtherCopy.prototype, field, { get: () => data[field] });
      }
   }
   return new OtherCopy();
}
