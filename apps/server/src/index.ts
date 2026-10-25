import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp({ config, logger: { level: config.production ? 'info' : 'debug' } });
await app.listen({ port: config.port, host: 'localhost' });
