import type {Bot, Context} from 'grammy';
import {AttachmentBuilder, EmbedBuilder, type TextChannel} from 'discord.js';
import {findBridgeByTelegram} from '../bridge.js';
// oxlint-disable-next-line no-unused-vars: TODO: implement
import {deleteByTelegram, findByTelegram, insertLink} from '../db.js';
import {getDiscordClient} from '../discord/client.js';

// oxlint-disable-next-line unicorn/number-literal-case: oxfmt makes this lowercase, don't want them fighting
const TELEGRAM_BLUE = 0x2a_ab_ee;
const MAX_DISCORD_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EMBED_DESC = 4096;

/** Build the display name for a Telegram user. */
function senderName(from: NonNullable<Context['message']>['from']): string {
  if (!from) {
    return 'Unknown';
  }
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return full || `@${from.username}` || String(from.id);
}

/** Fetch a Telegram profile photo URL for a user, or undefined if unavailable. */
async function getProfilePhotoUrl(
  bot: Bot,
  userId: number,
  token: string,
): Promise<string | undefined> {
  try {
    const photos = await bot.api.getUserProfilePhotos(userId, {limit: 1});
    if (photos.total_count === 0) {
      return undefined;
    }
    const fileId = photos.photos[0][0].file_id;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      return undefined;
    }
    return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  } catch {
    return undefined;
  }
}

/** Download a file from Telegram into a Buffer. Returns undefined if it fails or is too large. */
async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  token: string,
): Promise<{buffer: Buffer; name: string} | undefined> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      return undefined;
    }
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      return undefined;
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_DISCORD_FILE_BYTES) {
      return undefined; // Too large - caller will send a link instead
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_DISCORD_FILE_BYTES) {
      return undefined;
    }

    const name = file.file_path.split('/').pop() ?? 'file';
    return {buffer, name};
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}...`;
}

/**
 * Apply Telegram spoiler entities to plain text, wrapping spoiler ranges
 * with Discord's ||...|| spoiler syntax.
 */
function applyTelegramSpoilers(
  text: string,
  entities:
    | ReadonlyArray<{type: string; offset: number; length: number}>
    | undefined,
): string {
  if (!entities) {
    return text;
  }
  const spoilers = entities
    .filter((entity) => entity.type === 'spoiler')
    // oxlint-disable-next-line id-length
    .sort((a, b) => a.offset - b.offset);
  if (spoilers.length === 0) {
    return text;
  }
  let result = '';
  let pos = 0;
  for (const entity of spoilers) {
    result += text.slice(pos, entity.offset);
    result += '||';
    result += text.slice(entity.offset, entity.offset + entity.length);
    result += '||';
    pos = entity.offset + entity.length;
  }
  result += text.slice(pos);
  return result;
}

export function registerTelegramHandlers(bot: Bot, token: string): void {
  // New messages
  bot.on('message', async (ctx) => {
    const bridge = findBridgeByTelegram(
      ctx.chat.id,
      ctx.message.message_thread_id,
    );
    if (!bridge) {
      return;
    }

    const {from} = ctx.message;

    // Skip other bots
    if (from?.is_bot) {
      return;
    }

    const discordClient = getDiscordClient();
    const channel = discordClient.channels.cache.get(bridge.discord_channel_id);
    if (!channel?.isTextBased()) {
      return;
    }
    const textChannel = channel as TextChannel;

    const name = senderName(from);
    const avatarUrl = from
      ? await getProfilePhotoUrl(bot, from.id, token)
      : undefined;

    const rawText = ctx.message.text ?? ctx.message.caption ?? '';
    const text = applyTelegramSpoilers(
      rawText,
      ctx.message.entities ?? ctx.message.caption_entities,
    );

    // Reply handling
    let discordReplyRef: string | undefined;
    let replyFieldValue: string | undefined;

    const replyMsg = ctx.message.reply_to_message;
    /* In Telegram group topics, every non-reply message has reply_to_message pointing to the
       topic creation message (message_id === message_thread_id). Skip that implicit parent -
       it is not a real user-initiated reply. Same pattern occurs in channel linked groups. */
    if (replyMsg && replyMsg.message_id !== ctx.message.message_thread_id) {
      const botId = bot.botInfo?.id;
      if (botId && replyMsg.from?.id === botId) {
        // Bot sent it --> originally from Discord --> attempt native Discord reply
        const link = findByTelegram(String(ctx.chat.id), replyMsg.message_id);
        if (link) {
          discordReplyRef = link.discordMessageId;
        }
      } else {
        // Telegram-authored message --> blockquote field in Discord embed
        const refName = replyMsg.from ? senderName(replyMsg.from) : 'Someone'; // Fallback if not defined
        const refRawText =
          replyMsg.text ??
          replyMsg.caption ??
          (replyMsg.sticker
            ? `[sticker: ${replyMsg.sticker.emoji ?? '🔖'}]`
            : undefined) ??
          (replyMsg.photo ? '[photo]' : undefined) ??
          (replyMsg.document
            ? `[file: ${replyMsg.document.file_name ?? 'document'}]`
            : undefined) ??
          '[message]';
        const refText = applyTelegramSpoilers(
          refRawText,
          replyMsg.entities ?? replyMsg.caption_entities,
        );
        const excerpt = truncate(refText, 100);
        replyFieldValue = `**${refName}**: ${excerpt}`;
      }
    }

    const embed = new EmbedBuilder()
      .setColor(TELEGRAM_BLUE)
      .setAuthor({iconURL: avatarUrl, name})
      // oxlint-disable-next-line unicorn/no-null
      .setDescription(truncate(text, MAX_EMBED_DESC) || null);

    if (replyFieldValue) {
      embed.addFields([
        {name: '↩️ Replying to', value: truncate(replyFieldValue, 1024)},
      ]);
    }

    const files: AttachmentBuilder[] = [];

    // Handle photo
    const {photo} = ctx.message;
    if (photo) {
      const largest = photo[photo.length - 1];
      const dl = await downloadTelegramFile(bot, largest.file_id, token);
      if (dl) {
        if (ctx.message.has_media_spoiler) {
          /* Discord embeds don't support spoilers - send as a bare SPOILER_ attachment
             so Discord applies the blur natively, without referencing it in the embed. */
          files.push(
            new AttachmentBuilder(dl.buffer, {name: `SPOILER_${dl.name}`}),
          );
        } else {
          files.push(new AttachmentBuilder(dl.buffer, {name: dl.name}));
          embed.setImage(`attachment://${dl.name}`);
        }
      } else {
        embed.setDescription(
          truncate(
            `${text ? `${text}\n` : ''}📎 [photo too large to embed]`,
            MAX_EMBED_DESC,
          ),
        );
      }
    }

    // Handle document/file
    const doc = ctx.message.document;
    if (doc) {
      const dl = await downloadTelegramFile(bot, doc.file_id, token);
      if (dl) {
        files.push(
          new AttachmentBuilder(dl.buffer, {name: doc.file_name ?? dl.name}),
        );
      } else {
        embed.setDescription(
          truncate(
            `${text ? `${text}\n` : ''}📎 [${doc.file_name ?? 'file'} - too large to attach]`,
            MAX_EMBED_DESC,
          ),
        );
      }
    }

    // Handle sticker
    const {sticker} = ctx.message;
    if (sticker) {
      const emoji = sticker.emoji ?? '🔖';
      // Use sticker thumbnail if animated
      const fileId =
        (sticker.is_animated || sticker.is_video) && sticker.thumbnail
          ? sticker.thumbnail.file_id
          : sticker.file_id;
      const dl = await downloadTelegramFile(bot, fileId, token);
      if (dl) {
        // Ensure the filename has an extension so Discord renders it inline
        const name = dl.name.includes('.') ? dl.name : `${dl.name}.webp`;
        files.push(new AttachmentBuilder(dl.buffer, {name}));
        embed.setImage(`attachment://${name}`);
        embed.setDescription(
          // oxlint-disable-next-line unicorn/no-null
          truncate(text ? `${text}\n${emoji}` : emoji, MAX_EMBED_DESC) || null,
        );
      } else {
        embed.setDescription(
          truncate(
            text ? `${text}\n${emoji} [sticker]` : `${emoji} [sticker]`,
            MAX_EMBED_DESC,
          ),
        );
      }
    }

    try {
      const sent = await textChannel.send({
        embeds: [embed],
        files,
        ...(discordReplyRef
          ? {reply: {failIfNotExists: false, messageReference: discordReplyRef}}
          : {}),
      });
      insertLink({
        discordChannelId: bridge.discord_channel_id,
        discordMessageId: sent.id,
        tgChatId: String(ctx.chat.id),
        tgMessageId: ctx.message.message_id,
      });
    } catch (error) {
      console.error('[tg-->discord] Failed to send message:', error);
    }
  });

  // Edited messages
  bot.on('edited_message', async (ctx) => {
    const bridge = findBridgeByTelegram(
      ctx.chat.id,
      ctx.editedMessage.message_thread_id,
    );
    if (!bridge) {
      return;
    }
    if (ctx.editedMessage.from?.is_bot) {
      return;
    }

    const link = findByTelegram(
      String(ctx.chat.id),
      ctx.editedMessage.message_id,
    );
    if (!link) {
      return;
    }

    const discordClient = getDiscordClient();
    const channel = discordClient.channels.cache.get(link.discordChannelId);
    if (!channel?.isTextBased()) {
      return;
    }
    const textChannel = channel as TextChannel;

    try {
      const msg = await textChannel.messages.fetch(link.discordMessageId);
      const newText = applyTelegramSpoilers(
        ctx.editedMessage.text ?? ctx.editedMessage.caption ?? '',
        ctx.editedMessage.entities ?? ctx.editedMessage.caption_entities,
      );
      // oxlint-disable-next-line prefer-destructuring
      const oldEmbed = msg.embeds[0];

      const updated = EmbedBuilder.from(oldEmbed).setDescription(
        // oxlint-disable-next-line unicorn/no-null
        truncate(newText, MAX_EMBED_DESC) || null,
      );

      await msg.edit({embeds: [updated]});
    } catch (error) {
      console.error('[tg-->discord] Failed to edit message:', error);
    }
  });
}
