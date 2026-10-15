// The reconnect hardening, browser side: messages sent while the socket is
// down are buffered and replayed, rather than the page reloading.
//
// A `frontendPreload` entry, not a `frontend` one: Theia builds its connection
// before any frontend module runs, so a rebind there would do nothing. The
// buffer size is the application's `theia.frontend.config.connectionBufferBytes`.

import { bindConnectionResilience } from '@hydranium/client-theia/browser';
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { ContainerModule } from '@theia/core/shared/inversify';

export default new ContainerModule((_bind, _unbind, isBound, rebind) => {
   const bufferBytes = FrontendApplicationConfigProvider.get()['connectionBufferBytes'];
   bindConnectionResilience(isBound, rebind, { bufferBytes: typeof bufferBytes === 'number' ? bufferBytes : undefined });
});
