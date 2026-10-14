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
export const BookstoreModelType = 'BookstoreModel';
export const BookstoreNodeType = 'BookstoreNode';

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
   readonly $type: typeof BookstoreModelType;
   nodes: Array<BookstoreNode>;
}

export interface BookstoreNode extends BookstoreElement {
   readonly $type: typeof BookstoreNodeType;
   name: string;
   target?: Reference<BookstoreNode>;
}

// --- Type Guards ---
export function isBookstoreElement(item: unknown): item is BookstoreElement {
   return !!item && typeof item === 'object' && '$type' in item && typeof (item as BookstoreElement).$type === 'string';
}

export function isBookstoreModel(item: unknown): item is BookstoreModel {
   return isBookstoreElement(item) && item.$type === BookstoreModelType;
}

export function isBookstoreNode(item: unknown): item is BookstoreNode {
   return isBookstoreElement(item) && item.$type === BookstoreNodeType;
}

export function isBookstoreKeywordNames(item: unknown): item is BookstoreKeywordNames {
   return item === '->' || item === 'node';
}

