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

/**
 * Convert Discord markdown content to Telegram HTML.
 * Finds the earliest markdown pattern in the text, converts it to a Telegram HTML tag,
 * then recurses on the remaining text. Plain text is HTML-escaped; code content is
 * escaped but not parsed further.
 */
function discordContentToTelegramHtml(text: string): string {
  type Handler = (match: RegExpExecArray) => string;

  // Patterns checked in precedence order; earliest match in the string wins.
  const patterns: [RegExp, Handler][] = [
    // Code block: ```lang\ncode``` - escape content, no further parsing
    [
      /```(\w*)\n?([\s\S]*?)```/,
      (markdownContent) => {
        const code = escapeHtml(markdownContent[2].replace(/\n$/, ''));
        return markdownContent[1]
          ? `<pre><code class="language-${escapeHtml(markdownContent[1])}">${code}</code></pre>`
          : `<pre>${code}</pre>`;
      },
    ],
    // Inline code: `code` - escape content, no further parsing
    [
      /`([^`\n]+)`/,
      (markdownContent) => `<code>${escapeHtml(markdownContent[1])}</code>`,
    ],
    // Bold + italic: ***text***
    [
      /\*\*\*(.+?)\*\*\*/s,
      (markdownContent) =>
        `<b><i>${discordContentToTelegramHtml(markdownContent[1])}</i></b>`,
    ],
    // Bold: **text**
    [
      /\*\*(.+?)\*\*/s,
      (markdownContent) =>
        `<b>${discordContentToTelegramHtml(markdownContent[1])}</b>`,
    ],
    // Italic + underline: ___text___
    [
      /___(.+?)___/s,
      (markdownContent) =>
        `<i><u>${discordContentToTelegramHtml(markdownContent[1])}</u></i>`,
    ],
    // Underline: __text__
    [
      /__(.+?)__/s,
      (markdownContent) =>
        `<u>${discordContentToTelegramHtml(markdownContent[1])}</u>`,
    ],
    // Italic (asterisk): *text*
    [
      /\*([^*\n]+)\*/,
      (markdownContent) =>
        `<i>${discordContentToTelegramHtml(markdownContent[1])}</i>`,
    ],
    // Italic (underscore): _text_ - only at word boundaries
    [
      /(?<!\w)_([^_\n]+)_(?!\w)/,
      (markdownContent) =>
        `<i>${discordContentToTelegramHtml(markdownContent[1])}</i>`,
    ],
    // Strikethrough: ~~text~~
    [
      /~~(.+?)~~/s,
      (markdownContent) =>
        `<s>${discordContentToTelegramHtml(markdownContent[1])}</s>`,
    ],
    // Spoiler: ||text||
    [
      /\|\|(.+?)\|\|/s,
      (markdownContent) =>
        `<tg-spoiler>${discordContentToTelegramHtml(markdownContent[1])}</tg-spoiler>`,
    ],
  ];

  // Find the earliest match across all patterns
  // oxlint-disable-next-line unicorn/no-null
  let earliest: {index: number; end: number; html: string} | null = null;
  for (const [regex, handler] of patterns) {
    const match = regex.exec(text);
    if (match !== null && (earliest === null || match.index < earliest.index)) {
      earliest = {
        end: match.index + match[0].length,
        html: handler(match),
        index: match.index,
      };
    }
  }

  if (earliest === null) {
    return escapeHtml(text);
  }

  return (
    escapeHtml(text.slice(0, earliest.index)) +
    earliest.html +
    discordContentToTelegramHtml(text.slice(earliest.end))
  );
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

    // Reply handling
    interface ReplyParams {
      reply_parameters?: {
        message_id: number;
        allow_sending_without_reply: boolean;
      };
    }
    let replyParams: ReplyParams = {};
    let replyPrefix = '';

    if (msg.reference?.messageId) {
      const repliedToUserId = msg.mentions.repliedUser?.id;
      if (repliedToUserId === client.user?.id) {
        // Bot sent it --> originally from Telegram --> attempt native TG reply
        const refChannelId = msg.reference.channelId ?? msg.channelId;
        const link = findByDiscord(refChannelId, msg.reference.messageId);
        if (link) {
          replyParams = {
            reply_parameters: {
              allow_sending_without_reply: true,
              message_id: link.tgMessageId,
            },
          };
        }
      } else {
        // Discord-authored message --> blockquote excerpt for Telegram
        try {
          const refMsg = await msg.channel.messages.fetch(
            msg.reference.messageId,
          );
          const refName = discordDisplayName(refMsg);
          const refContent =
            refMsg.content ||
            (refMsg.attachments.size > 0 ? '[attachment]' : '') ||
            (refMsg.stickers.size > 0
              ? `[sticker: ${refMsg.stickers.first()!.name}]`
              : '') ||
            '[message]';
          const excerpt = truncate(refContent, 100);
          replyPrefix = `<blockquote><b>${escapeHtml(refName)}</b>: ${discordContentToTelegramHtml(excerpt)}</blockquote>\n`;
        } catch {
          // Ignore - can't fetch the message, proceed without quote
        }
      }
    }

    // If there are attachments, handle them first
    if (msg.attachments.size > 0) {
      let replyApplied = false;
      for (const attachment of msg.attachments.values()) {
        const dl = await downloadDiscordAttachment(attachment);
        const prefix = replyApplied ? '' : replyPrefix;
        const baseCaption = content
          ? truncate(
              `${prefix}${header}: ${discordContentToTelegramHtml(content)}`,
              MAX_TG_TEXT,
            )
          : `${prefix}${header}`;
        const caption = truncate(baseCaption, MAX_TG_TEXT);

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
                  ...(attachment.spoiler ? {has_spoiler: true} : {}),
                  ...threadOpts,
                  ...replyParams,
                },
              );
            } else {
              sentMsg = await bot.api.sendDocument(
                bridge.telegram_chat_id,
                inputFile,
                {caption, parse_mode: 'HTML', ...threadOpts, ...replyParams},
              );
            }
          } else {
            // File too large - send link
            const linkText = truncate(
              `${prefix}${header}: ${discordContentToTelegramHtml(content ? `${content}\n` : '')}📎 <a href="${attachment.url}">${escapeHtml(attachment.name)}</a>`,
              MAX_TG_TEXT,
            );
            sentMsg = await bot.api.sendMessage(
              bridge.telegram_chat_id,
              linkText,
              {
                parse_mode: 'HTML',
                ...threadOpts,
                ...replyParams,
              },
            );
          }

          replyApplied = true;
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
      let replyApplied = false;
      for (const sticker of msg.stickers.values()) {
        const prefix = replyApplied ? '' : replyPrefix;
        const caption = content
          ? truncate(
              `${prefix}${header}: ${discordContentToTelegramHtml(content)}`,
              MAX_TG_TEXT,
            )
          : `${prefix}${header}: [sticker: ${escapeHtml(sticker.name)}]`;

        try {
          let sentMsg;
          if (sticker.format === StickerFormatType.Lottie) {
            // Lottie is JSON-based vector; can't send as image
            sentMsg = await bot.api.sendMessage(
              bridge.telegram_chat_id,
              caption,
              {parse_mode: 'HTML', ...threadOpts, ...replyParams},
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
                  {caption, parse_mode: 'HTML', ...threadOpts, ...replyParams},
                );
              } else {
                // Attribution for stickers (since we can't caption a sticker)
                await bot.api.sendMessage(bridge.telegram_chat_id, caption, {
                  parse_mode: 'HTML',
                  ...threadOpts,
                  ...replyParams,
                });
                // Then send as a sticker to keep transparency
                sentMsg = await bot.api.sendSticker(
                  bridge.telegram_chat_id,
                  inputFile,
                  {...threadOpts},
                );
              }
            } else {
              sentMsg = await bot.api.sendMessage(
                bridge.telegram_chat_id,
                caption,
                {parse_mode: 'HTML', ...threadOpts, ...replyParams},
              );
            }
          }

          replyApplied = true;
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
    const text = truncate(
      `${replyPrefix}${header}: ${discordContentToTelegramHtml(content)}`,
      MAX_TG_TEXT,
    );

    try {
      const sentMsg = await bot.api.sendMessage(bridge.telegram_chat_id, text, {
        parse_mode: 'HTML',
        ...threadOpts,
        ...replyParams,
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
      `<b>${escapeHtml(name)}</b>: ${discordContentToTelegramHtml(content)}`,
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
