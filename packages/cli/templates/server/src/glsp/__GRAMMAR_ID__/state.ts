// GLSP state for the __GRAMMAR__ diagram.
//
// `FullTextHydraniumGlspState` is the simplest of the framework source-model
// strategies (the others project a structured transfer model, over one document
// or several): the source model is the whole document text, serialised through
// the per-URI `Serializer` and round-tripped by re-parsing. Both seams resolve
// through shared services, so narrowing the root type is all an adopter adds.
//
// It cannot field-merge — every concurrent edit on a whole-document model is a
// same-document collision, so undo / redo degrade to drop-on-divergence. Move to
// `ReconcilingTransferHydraniumGlspState` when you need field-level undo.

import { FullTextHydraniumGlspState } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';

@injectable()
export class __GRAMMAR__GlspState extends FullTextHydraniumGlspState<__ENTRY_RULE__> {}
