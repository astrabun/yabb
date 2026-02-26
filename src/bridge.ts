import type {Bridge} from './config.js';

let bridges: Bridge[] = [];

export function initBridges(configured: Bridge[]): void {
  bridges = configured;
}

/**
 * Find the bridge for a given Telegram chat and optional thread (topic).
 *
 * Matching rules:
 * - If the bridge has `telegram_thread_id` set, it only matches messages in that thread.
 * - If the bridge has no `telegram_thread_id`, it only matches messages NOT in a thread
 *   (i.e. plain groups, or the default non-topic channel of a forum group).
 */
export function findBridgeByTelegram(
  chatId: string | number,
  threadId?: number,
): Bridge | undefined {
  const id = String(chatId);
  return bridges.find((bridge) => {
    if (bridge.telegram_chat_id !== id) {
      return false;
    }
    if (bridge.telegram_thread_id !== undefined) {
      return threadId === bridge.telegram_thread_id;
    }
    return threadId === undefined;
  });
}

/** Find the bridge that corresponds to a given Discord channel ID. */
export function findBridgeByDiscord(channelId: string): Bridge | undefined {
  return bridges.find((bridge) => bridge.discord_channel_id === channelId);
}
