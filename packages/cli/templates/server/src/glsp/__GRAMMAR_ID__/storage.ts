// Source-model storage for the __GRAMMAR__ diagram, inheriting both framework
// defaults: `loadSourceModel` (open + settle + `setSourceRoot`) and
// `saveSourceModel` (flush the store's text for the primary and every tracked
// secondary through the diagram's client session).
//
// No serializer runs on the save path — a save persists what the diagram's
// operations already wrote to the store.
//
// The subclass exists so a bespoke load or save has a stable place to land.

import { type FullTextSourceModel, HydraniumGlspStorage } from '@hydranium/glsp-server';
import { injectable } from 'inversify';
import type { __ENTRY_RULE__ } from '../../language-server/ast.js';

@injectable()
export class __GRAMMAR__GlspStorage extends HydraniumGlspStorage<__ENTRY_RULE__, FullTextSourceModel> {}
