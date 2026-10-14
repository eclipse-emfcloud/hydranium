/******************************************************************************
 * Generated from the Langium AST — DO NOT EDIT MANUALLY!
 * Run: npm --prefix examples/bookstore/server run generate:transfer-model
 ******************************************************************************/

/* eslint-disable */

import { makeTransferNodeBuilder } from '@hydranium/protocol/testing';
import { BookstoreTransferReflection, type BookstoreTransferTypes } from '@hydranium/bookstore-protocol';

/**
 * Transfer-node factory for this project's grammar, for tests. It fills the
 * grammar defaults, so a test names only the fields it cares about;
 * `transferNode.partial` fills none and types the node as incomplete.
 */
export const transferNode = makeTransferNodeBuilder<BookstoreTransferTypes, typeof BookstoreTransferReflection>(BookstoreTransferReflection);
