/******************************************************************************
 * Generated from the Langium AST — DO NOT EDIT MANUALLY!
 * Run: npm --prefix examples/order-flow/server run generate:transfer-model
 ******************************************************************************/

/* eslint-disable */

import { makeAstNodeBuilder } from '@hydranium/core';
import { reflection, type OrderFlowAstType, type Domain, type Layout, type Process } from '../generated/ast.js';

/**
 * AST-node factory spanning every grammar in this project.
 *
 * Prefer the narrowed binding matching the grammar the call site works in:
 * it rejects a type outside that grammar's import closure, which this one
 * accepts from anywhere. Reach for this one where a call site genuinely
 * spans grammars.
 */
export const astNode = makeAstNodeBuilder<OrderFlowAstType>(reflection);

/**
 * AST-node factory narrowed to the 'Domain' grammar.
 *
 * Narrowed by grammar REACHABILITY, not by ownership: a grammar that
 * imports another sees that one's types too, so this binding is only as
 * narrow as 'Domain's import closure. Where that closure is the
 * whole project, it accepts exactly what the merged binding does and the
 * choice is documentation rather than a check.
 *
 * Mandatory fields are a type error at the call site, and grammar-declared
 * containment arrays are materialised from reflection metadata, so a built
 * node carries `[]` where a cast literal would leave `undefined`.
 */
export const domainNode = makeAstNodeBuilder<Domain.AstType>(reflection);

/**
 * AST-node factory narrowed to the 'Layout' grammar.
 *
 * Narrowed by grammar REACHABILITY, not by ownership: a grammar that
 * imports another sees that one's types too, so this binding is only as
 * narrow as 'Layout's import closure. Where that closure is the
 * whole project, it accepts exactly what the merged binding does and the
 * choice is documentation rather than a check.
 *
 * Mandatory fields are a type error at the call site, and grammar-declared
 * containment arrays are materialised from reflection metadata, so a built
 * node carries `[]` where a cast literal would leave `undefined`.
 */
export const layoutNode = makeAstNodeBuilder<Layout.AstType>(reflection);

/**
 * AST-node factory narrowed to the 'Process' grammar.
 *
 * Narrowed by grammar REACHABILITY, not by ownership: a grammar that
 * imports another sees that one's types too, so this binding is only as
 * narrow as 'Process's import closure. Where that closure is the
 * whole project, it accepts exactly what the merged binding does and the
 * choice is documentation rather than a check.
 *
 * Mandatory fields are a type error at the call site, and grammar-declared
 * containment arrays are materialised from reflection metadata, so a built
 * node carries `[]` where a cast literal would leave `undefined`.
 */
export const processNode = makeAstNodeBuilder<Process.AstType>(reflection);
