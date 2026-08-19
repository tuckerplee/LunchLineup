import { loadConfig } from './config';
import { buildServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer(config);
  let closing = false;

  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'api_v2_shutdown_started');
    const forced = setTimeout(() => {
      app.log.error({ signal }, 'api_v2_shutdown_timeout');
      process.exit(1);
    }, 15_000);
    forced.unref();
    try {
      await app.close();
      clearTimeout(forced);
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error, signal }, 'api_v2_shutdown_failed');
      process.exit(1);
    }
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info({ port: config.port, releaseSha: config.releaseSha }, 'api_v2_started');
  } catch (error) {
    app.log.fatal({ err: error }, 'api_v2_start_failed');
    await app.close().catch(() => undefined);
    process.exit(1);
  }
}

void main();
