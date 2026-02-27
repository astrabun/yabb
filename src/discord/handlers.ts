import {
  type Attachment,
  type Client,
  Events,
  type Message,
  type PartialMessage,
  StickerFormatType,
} from 'discord.js';
import {findBridgeByDiscord} from '../bridge.js';
import {deleteByDiscord, findByDiscord, insertLink} from '../db.js';
import {getBot} from '../telegram/client.js';
import {InputFile} from 'grammy';

const MAX_TG_TEXT = 4096;
const MAX_TG_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Escape HTML special chars in user-supplied text before sending to Telegram. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}...`;
}

/** Build the Telegram display name for a Discord message author. */
function discordDisplayName(msg: Message | PartialMessage): string {
  if (!msg.member) {
    return msg.author?.username ?? 'Unknown';
  }
  return msg.member.displayName || msg.author?.username || 'Unknown';
}

/** Download a Discord attachment as a Buffer. Returns undefined if it fails or is too large. */
async function downloadDiscordAttachment(
  attachment: Attachment,
): Promise<{buffer: Buffer; name: string} | undefined> {
  if (attachment.size > MAX_TG_FILE_BYTES) {
    return undefined;
  }
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) {
      return undefined;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {buffer, name: attachment.name};
  } catch {
    return undefined;
  }
}

export function registerDiscordHandlers(client: Client): void {
  // New Messages
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) {
      return;
    }

    const bridge = findBridgeByDiscord(msg.channelId);
    if (!bridge) {
      return;
    }

    const bot = getBot();
    const name = discordDisplayName(msg);
    const content = msg.content ?? '';
    const header = `<b>${escapeHtml(name)}</b>`;

    const threadOpts =
      bridge.telegram_thread_id !== undefined
        ? {message_thread_id: bridge.telegram_thread_id}
        : {};

    // If there are attachments, handle them first
    if (msg.attachments.size > 0) {
      for (const attachment of msg.attachments.values()) {
        const dl = await downloadDiscordAttachment(attachment);
        const caption = content
          ? truncate(`${header}: ${escapeHtml(content)}`, MAX_TG_TEXT)
          : header;

        try {
          let sentMsg;
          if (dl) {
            const inputFile = new InputFile(dl.buffer, dl.name);
            if (attachment.contentType?.startsWith('image/')) {
              sentMsg = await bot.api.sendPhoto(
                bridge.telegram_chat_id,
                inputFile,
                {
                  caption,
                  parse_mode: 'HTML',
                  ...threadOpts,
                },
              );
            } else {
              sentMsg = await bot.api.sendDocument(
                bridge.telegram_chat_id,
                inputFile,
                {caption, parse_mode: 'HTML', ...threadOpts},
              );
            }
          } else {
            // File too large — send link
            const linkText = truncate(
              `${header}: ${escapeHtml(content ? `${content}\n` : '')}📎 <a href="${attachment.url}">${escapeHtml(attachment.name)}</a>`,
              MAX_TG_TEXT,
            );
            sentMsg = await bot.api.sendMessage(
              bridge.telegram_chat_id,
              linkText,
              {
                parse_mode: 'HTML',
                ...threadOpts,
              },
            );
          }

          insertLink({
            discordChannelId: msg.channelId,
            discordMessageId: msg.id,
            tgChatId: bridge.telegram_chat_id,
            tgMessageId: sentMsg.message_id,
          });
        } catch (error) {
          console.error('[discord-->tg] Failed to send attachment:', error);
        }
      }
      return;
    }

    // Stickers
    if (msg.stickers.size > 0) {
      for (const sticker of msg.stickers.values()) {
        const caption = content
          ? truncate(`${header}: ${escapeHtml(content)}`, MAX_TG_TEXT)
          : `${header}: [sticker: ${escapeHtml(sticker.name)}]`;

        try {
          let sentMsg;
          if (sticker.format === StickerFormatType.Lottie) {
            // Lottie is JSON-based vector; can't send as image
            sentMsg = await bot.api.sendMessage(
              bridge.telegram_chat_id,
              caption,
              {parse_mode: 'HTML', ...threadOpts},
            );
          } else {
            const res = await fetch(sticker.url);
            if (res.ok) {
              const buffer = Buffer.from(await res.arrayBuffer());
              const ext =
                sticker.format === StickerFormatType.GIF ? 'gif' : 'png';
              const inputFile = new InputFile(buffer, `${sticker.name}.${ext}`);
              if (sticker.format === StickerFormatType.GIF) {
                sentMsg = await bot.api.sendAnimation(
                  bridge.telegram_chat_id,
                  inputFile,
                  {caption, parse_mode: 'HTML', ...threadOpts},
                );
              } else {
                sentMsg = await bot.api.sendPhoto(
                  bridge.telegram_chat_id,
                  inputFile,
                  {caption, parse_mode: 'HTML', ...threadOpts},
                );
              }
            } else {
              sentMsg = await bot.api.sendMessage(
                bridge.telegram_chat_id,
                caption,
                {parse_mode: 'HTML', ...threadOpts},
              );
            }
          }

          insertLink({
            discordChannelId: msg.channelId,
            discordMessageId: msg.id,
            tgChatId: bridge.telegram_chat_id,
            tgMessageId: sentMsg.message_id,
          });
        } catch (error) {
          console.error('[discord-->tg] Failed to send sticker:', error);
        }
      }
      return;
    }

    // Text-only message
    if (!content) {
      return;
    }
    const text = truncate(`${header}: ${escapeHtml(content)}`, MAX_TG_TEXT);

    try {
      const sentMsg = await bot.api.sendMessage(bridge.telegram_chat_id, text, {
        parse_mode: 'HTML',
        ...threadOpts,
      });
      insertLink({
        discordChannelId: msg.channelId,
        discordMessageId: msg.id,
        tgChatId: bridge.telegram_chat_id,
        tgMessageId: sentMsg.message_id,
      });
    } catch (error) {
      console.error('[discord-->tg] Failed to send message:', error);
    }
  });

  // Edited messages
  client.on(Events.MessageUpdate, async (_oldMsg, newMsg) => {
    if (newMsg.partial) {
      try {
        newMsg = await newMsg.fetch();
      } catch {
        return;
      }
    }
    if (newMsg.author?.bot) {
      return;
    }

    const bridge = findBridgeByDiscord(newMsg.channelId);
    if (!bridge) {
      return;
    }

    const link = findByDiscord(newMsg.channelId, newMsg.id);
    if (!link) {
      return;
    }

    const bot = getBot();
    const name = discordDisplayName(newMsg);
    const content = newMsg.content ?? '';
    const text = truncate(
      `<b>${escapeHtml(name)}</b>: ${escapeHtml(content)}`,
      MAX_TG_TEXT,
    );

    try {
      await bot.api.editMessageText(link.tgChatId, link.tgMessageId, text, {
        parse_mode: 'HTML',
      });
    } catch (error) {
      console.error('[discord-->tg] Failed to edit message:', error);
    }
  });

  // Deleted Messages
  client.on(Events.MessageDelete, async (msg) => {
    const bridge = findBridgeByDiscord(msg.channelId);
    if (!bridge) {
      return;
    }

    const link = findByDiscord(msg.channelId, msg.id);
    if (!link) {
      return;
    }

    const bot = getBot();
    try {
      await bot.api.deleteMessage(link.tgChatId, link.tgMessageId);
    } catch (error) {
      console.error('[discord-->tg] Failed to delete message:', error);
    }

    deleteByDiscord(msg.channelId, msg.id);
  });
}
