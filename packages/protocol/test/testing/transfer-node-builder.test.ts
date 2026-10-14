/********************************************************************************
 * Copyright (c) 2026 EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { makeTransferNodeBuilder, type TransferTypeConstant } from '../../src/testing/transfer-node-builder';

interface TypeOne {
   readonly $type: 'TypeOne';
   name: string;
   flag: boolean;
   items: string[];
   /** Derived, so no grammar default reaches it. */
   readonly _derived: string[];
}

interface TypeTwo {
   readonly $type: 'TypeTwo';
   children: TypeOne[];
}

type Either = TypeOne | TypeTwo;

/** A concrete type with a subtype: Langium lists the type's own name in its `$type` union. */
interface Base {
   readonly $type: 'Base' | 'Derived';
   label: string;
}

interface Derived extends Base {
   readonly $type: 'Derived';
}

const TypeOne = { $type: 'TypeOne', name: 'name', flag: 'flag', items: 'items' } as const;
const TypeTwo = { $type: 'TypeTwo', children: 'children' } as const;
const Either = { $type: 'Either' } as const;
const Base = { $type: 'Base', label: 'label' } as const;
const Derived = { $type: 'Derived', label: 'label' } as const;

type MetaData = { readonly properties: Readonly<Record<string, { readonly defaultValue?: unknown }>> };

/** The shape the generator emits: literal `types`, with the defaults a grammar produces, `[]` for a list and `false` for a `?=` flag. */
const reflection = {
   types: {
      TypeOne: { properties: { name: {}, flag: { defaultValue: false }, items: { defaultValue: [] } } },
      TypeTwo: { properties: { children: { defaultValue: [] } } },
      Either: { properties: {} },
      Base: { properties: { label: {} } },
      Derived: { properties: { label: {} } }
   } as const,
   getTypeMetaData(type: string): MetaData {
      return Object.prototype.hasOwnProperty.call(this.types, type)
         ? (this.types as Readonly<Record<string, MetaData>>)[type]
         : { properties: {} };
   }
};

const transferNode = makeTransferNodeBuilder<
   { TypeOne: TypeOne; TypeTwo: TypeTwo; Either: Either; Base: Base; Derived: Derived },
   typeof reflection
>(reflection);

describe('makeTransferNodeBuilder', () => {
   it('fills the grammar defaults under the fields a test names', () => {
      expect(transferNode(TypeOne, { name: 'a', _derived: [] })).toEqual({
         $type: 'TypeOne',
         name: 'a',
         flag: false,
         items: [],
         _derived: []
      });
      expect(transferNode(TypeOne, { name: 'a', flag: true, _derived: ['b'] }).flag).toBe(true);
   });

   it('gives each node its own default array', () => {
      const first = transferNode(TypeTwo, {});
      const second = transferNode(TypeTwo, {});
      first.children.push(transferNode(TypeOne, { name: 'a', _derived: [] }));

      expect(second.children).toEqual([]);
   });

   it('keeps a grammar default the init names as undefined', () => {
      const node = transferNode(TypeOne, { name: 'a', flag: undefined, items: undefined, _derived: [] });

      expect(node.flag).toBe(false);
      expect(node.items).toEqual([]);
   });

   it('fills nothing for a partial node', () => {
      expect(transferNode.partial(TypeOne, { name: 'a' })).toEqual({ $type: 'TypeOne', name: 'a' });
      expect(transferNode.partial(TypeTwo)).toEqual({ $type: 'TypeTwo' });
   });

   it('holds the init to the interface', () => {
      // @ts-expect-error `name` has no grammar default.
      transferNode(TypeOne, { _derived: [] });
      // @ts-expect-error a derived field is never defaulted, array or not.
      transferNode(TypeOne, { name: 'a' });
      // @ts-expect-error not a field of TypeOne.
      transferNode(TypeOne, { name: 'a', _derived: [], other: 1 });
      // @ts-expect-error the constant supplies `$type`, so the init may not name it, even rightly.
      transferNode(TypeOne, { $type: 'TypeOne', name: 'a', _derived: [] });
      const partial = transferNode.partial(TypeOne, { name: 'a' });
      // @ts-expect-error a partial node admits that a field may be missing.
      const name: string = partial.name;

      expect(name).toBe('a');
   });

   it('refuses the constant of a union, which no node carries as its type', () => {
      // @ts-expect-error `Either` names no node's `$type`.
      transferNode(Either, {});
      // @ts-expect-error nor does a partial node's.
      transferNode.partial(Either);
   });

   it('refuses a constant whose $type is not one type name', () => {
      const selected: TransferTypeConstant<'TypeOne' | 'TypeTwo'> = TypeOne;
      const baseOrDerived: TransferTypeConstant<Base['$type']> = Base;

      // @ts-expect-error either type could be built, so neither's required fields would be checked.
      transferNode(selected, {});
      // @ts-expect-error nor a partial node's.
      transferNode.partial(selected);
      // @ts-expect-error a constant typed by a $type that lists subtypes is a union too.
      transferNode(baseOrDerived, { label: 'a' });
   });

   it('builds a concrete type that has subtypes, whose $type lists its own name', () => {
      expect(transferNode(Base, { label: 'a' })).toEqual({ $type: 'Base', label: 'a' });
      expect(transferNode.partial(Base).$type).toBe('Base');
      expect(transferNode(Derived, { label: 'a' }).$type).toBe('Derived');
   });

   it("keeps the constant's $type when the init carries another", () => {
      // A spread of another node passes the type check, since only a literal
      // written in the call has its extra properties rejected.
      const other = { $type: 'TypeTwo', name: 'a', _derived: [] };

      expect(transferNode(TypeOne, other).$type).toBe('TypeOne');
      expect(transferNode.partial(TypeOne, other).$type).toBe('TypeOne');
   });
});
