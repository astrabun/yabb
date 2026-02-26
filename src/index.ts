import {loadConfig} from './config.js';
import {closeDb, openDb} from './db.js';
import {initBridges} from './bridge.js';
import {createBot} from './telegram/client.js';
import {registerTelegramHandlers} from './telegram/handlers.js';
import {createDiscordClient} from './discord/client.js';
import {registerDiscordHandlers} from './discord/handlers.js';
import {Events} from 'discord.js';

async function main() {
  const config = loadConfig();

  openDb();
  initBridges(config.bridges);

  console.log(
    `[yabb] Starting with ${config.bridges.length} bridge(s):`,
    config.bridges.map((bridge) => bridge.name).join(', '),
  );

  const discordClient = createDiscordClient();
  registerDiscordHandlers(discordClient);

  discordClient.once(Events.ClientReady, (client) => {
    console.log(`[discord] Logged in as ${client.user.tag}`);
  });

  const bot = createBot(config.telegramToken);
  registerTelegramHandlers(bot, config.telegramToken);

  await discordClient.login(config.discordToken);
  void bot.start({
    onStart: (info) => console.log(`[telegram] Polling as @${info.username}`),
  });

  async function shutdown(signal: string) {
    console.log(`\n[yabb] Received ${signal}, shutting down…`);
    try {
      await bot.stop();
      void discordClient.destroy();
      closeDb();
      console.log('[yabb] Clean shutdown complete.');
    } catch (error) {
      console.error('[yabb] Error during shutdown:', error);
    }
    process.exit(0);
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[yabb] Fatal error:', error);
  process.exit(1);
});
