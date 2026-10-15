/******************************************************************************
 * Generated from the Langium AST — DO NOT EDIT MANUALLY!
 * Run: npm --prefix examples/bookstore/server run generate:transfer-model
 ******************************************************************************/

/* eslint-disable */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type Reference<T> = string;

export interface BookstoreElement {
   readonly $type: string;
}

// --- Type Constants ---
export const BookstoreModel = { $type: 'BookstoreModel', nodes: 'nodes' } as const;
export const BookstoreNode = { $type: 'BookstoreNode', name: 'name', target: 'target' } as const;

// --- Type Aliases ---
export type BookstoreKeywordNames = | "->"
    | "node";
export const BookstoreKeywordNamesValues = ['->', 'node'] as const;

// --- Terminal Patterns (anchored for validation) ---
export const BookstoreTerminals = {
   WS: /^(?:\s+)$/,
   ID: /^(?:[_a-zA-Z][\w_]*)$/,
   SL_COMMENT: /^(?:\/\/[^\n\r]*)$/,
   ML_COMMENT: /^(?:\/\*[\s\S]*?\*\/)$/,
};

// --- Interfaces ---
export interface BookstoreModel extends BookstoreElement {
   readonly $type: 'BookstoreModel';
   nodes: Array<BookstoreNode>;
}

export interface BookstoreNode extends BookstoreElement {
   readonly $type: 'BookstoreNode';
   name: string;
   target?: Reference<BookstoreNode>;
}

// --- Type Guards ---
export function isBookstoreElement(item: unknown): item is BookstoreElement {
   return !!item && typeof item === 'object' && '$type' in item && typeof (item as BookstoreElement).$type === 'string';
}

export function isBookstoreModel(item: unknown): item is BookstoreModel {
   return isBookstoreElement(item) && item.$type === 'BookstoreModel';
}

export function isBookstoreNode(item: unknown): item is BookstoreNode {
   return isBookstoreElement(item) && item.$type === 'BookstoreNode';
}

export function isBookstoreKeywordNames(item: unknown): item is BookstoreKeywordNames {
   return item === '->' || item === 'node';
}

// --- Type Map ---
export type BookstoreTransferTypes = {
   BookstoreModel: BookstoreModel;
   BookstoreNode: BookstoreNode;
};

// --- Reflection ---
export interface BookstoreTransferTypeMetaData {
   readonly name: string;
   readonly properties: {
      readonly [name: string]: { readonly name: string; readonly defaultValue?: unknown; readonly optional?: boolean; readonly referenceType?: string };
   };
   readonly superTypes: readonly string[];
}

export const BookstoreTransferReflection = {
   types: {
      BookstoreModel: { name: 'BookstoreModel', properties: { nodes: { name: 'nodes', defaultValue: [], optional: true } }, superTypes: [] },
      BookstoreNode: { name: 'BookstoreNode', properties: { name: { name: 'name' }, target: { name: 'target', optional: true, referenceType: 'BookstoreNode' } }, superTypes: [] },
   } as const satisfies { readonly [type: string]: BookstoreTransferTypeMetaData },

   getAllTypes(): string[] {
      return Object.keys(this.types);
   },

   getTypeMetaData(type: string): BookstoreTransferTypeMetaData {
      return Object.prototype.hasOwnProperty.call(this.types, type)
         ? (this.types as { readonly [type: string]: BookstoreTransferTypeMetaData })[type]
         : { name: type, properties: {}, superTypes: [] };
   },

   isSubtype(subtype: string, supertype: string): boolean {
      return subtype === supertype || this.getTypeMetaData(subtype).superTypes.some(type => this.isSubtype(type, supertype));
   },

   getAllSubTypes(type: string): string[] {
      return this.getAllTypes().filter(candidate => this.isSubtype(candidate, type));
   },

   isInstance(item: unknown, type: string): boolean {
      return isBookstoreElement(item) && this.isSubtype(item.$type, type);
   }
};

