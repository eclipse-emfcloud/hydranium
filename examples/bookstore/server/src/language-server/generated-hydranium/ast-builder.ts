/******************************************************************************
 * Generated from the Langium AST — DO NOT EDIT MANUALLY!
 * Run: npm --prefix examples/bookstore/server run generate:transfer-model
 ******************************************************************************/

/* eslint-disable */

import { makeAstNodeBuilder } from '@hydranium/core';
import { reflection, type BookstoreAstType } from '../generated/ast.js';

/**
 * AST-node factory for this project's grammar.
 *
 * Mandatory fields are a type error at the call site, and grammar-declared
 * containment arrays are materialised from reflection metadata, so a built
 * node carries `[]` where a cast literal would leave `undefined`.
 */
export const astNode = makeAstNodeBuilder<BookstoreAstType>(reflection);
