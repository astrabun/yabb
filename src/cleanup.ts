import {GrammyError, type Bot} from 'grammy';
import type {TextChannel} from 'discord.js';
import {getBridges} from './bridge.js';
import {deleteByTelegram, getRecentLinksByTgChat} from './db.js';
import {getDiscordClient} from './discord/client.js';
import type {CleanupConfig} from './config.js';

export async function runCleanup(
  bot: Bot,
  config: CleanupConfig,
): Promise<void> {
  const {sinkChatId, sinkThreadId, lookback} = config;
  const discordClient = getDiscordClient();

  // Deduplicate bridges by tg_chat_id - multiple bridges can share a chat (different threads)
  const chatIds = [
    ...new Set(getBridges().map((bridge) => bridge.telegram_chat_id)),
  ];

  for (const tgChatId of chatIds) {
    const links = getRecentLinksByTgChat(tgChatId, lookback);

    for (const link of links) {
      let exists: boolean;
      try {
        const probe = await bot.api.forwardMessage(
          sinkChatId,
          link.tgChatId,
          link.tgMessageId,
          sinkThreadId !== undefined ? {message_thread_id: sinkThreadId} : {},
        );
        exists = true;
        try {
          await bot.api.deleteMessage(sinkChatId, probe.message_id);
        } catch {
          // Non-critical - sink message will just sit there
        }
      } catch (error) {
        if (error instanceof GrammyError && error.error_code === 400) {
          exists = false;
        } else {
          console.error(
            `[cleanup] Error probing TG message ${link.tgMessageId} in chat ${tgChatId}:`,
            error,
          );
          exists = true; // Treat as still existing to avoid false deletions
        }
      }

      if (!exists) {
        const channel = discordClient.channels.cache.get(link.discordChannelId);
        if (channel?.isTextBased()) {
          try {
            const msg = await (channel as TextChannel).messages.fetch(
              link.discordMessageId,
            );
            await msg.delete();
          } catch {
            // Discord message already gone - still clean up the DB entry
          }
        }
        deleteByTelegram(link.tgChatId, link.tgMessageId);
        console.log(
          `[cleanup] Deleted orphaned Discord mirror for TG message ${link.tgMessageId} (chat ${tgChatId})`,
        );
      }
    }
  }
}
