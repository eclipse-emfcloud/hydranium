// The reconnect hardening, backend side: the session outlives a dropped socket
// for the application's `frontendConnectionTimeout`, and messages for the page
// wait in a buffer of `theia.backend.config.connectionBufferBytes`.

import { bindConnectionResilience } from '@hydranium/client-theia/node';
import { BackendApplicationConfigProvider } from '@theia/core/lib/node/backend-application-config-provider';
import { ContainerModule } from '@theia/core/shared/inversify';

export default new ContainerModule((bind, _unbind, isBound, rebind) => {
   const bufferBytes = BackendApplicationConfigProvider.get()['connectionBufferBytes'];
   bindConnectionResilience(bind, isBound, rebind, { bufferBytes: typeof bufferBytes === 'number' ? bufferBytes : undefined });
});
