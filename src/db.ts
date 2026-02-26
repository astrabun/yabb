import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface MessageLink {
  tgChatId: string;
  tgMessageId: number;
  discordChannelId: string;
  discordMessageId: string;
}

let db: Database.Database;

export function openDb(): void {
  const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');
  fs.mkdirSync(dataDir, {recursive: true});

  db = new Database(path.join(dataDir, 'bb.sqlite'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_links (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_chat_id          TEXT    NOT NULL,
      tg_message_id       INTEGER NOT NULL,
      discord_channel_id  TEXT    NOT NULL,
      discord_message_id  TEXT    NOT NULL,
      created_at          INTEGER DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tg
      ON message_links(tg_chat_id, tg_message_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_discord
      ON message_links(discord_channel_id, discord_message_id);
  `);
}

export function closeDb(): void {
  db?.close();
}

export function insertLink(link: MessageLink): void {
  db.prepare(
    `INSERT OR REPLACE INTO message_links
       (tg_chat_id, tg_message_id, discord_channel_id, discord_message_id)
     VALUES (?, ?, ?, ?)`,
  ).run(
    link.tgChatId,
    link.tgMessageId,
    link.discordChannelId,
    link.discordMessageId,
  );
}

export function findByTelegram(
  tgChatId: string,
  tgMessageId: number,
): Pick<MessageLink, 'discordChannelId' | 'discordMessageId'> | undefined {
  return db
    .prepare(
      `SELECT discord_channel_id AS discordChannelId,
              discord_message_id AS discordMessageId
       FROM message_links
       WHERE tg_chat_id = ? AND tg_message_id = ?`,
    )
    .get(tgChatId, tgMessageId) as
    | Pick<MessageLink, 'discordChannelId' | 'discordMessageId'>
    | undefined;
}

export function findByDiscord(
  discordChannelId: string,
  discordMessageId: string,
): Pick<MessageLink, 'tgChatId' | 'tgMessageId'> | undefined {
  return db
    .prepare(
      `SELECT tg_chat_id      AS tgChatId,
              tg_message_id   AS tgMessageId
       FROM message_links
       WHERE discord_channel_id = ? AND discord_message_id = ?`,
    )
    .get(discordChannelId, discordMessageId) as
    | Pick<MessageLink, 'tgChatId' | 'tgMessageId'>
    | undefined;
}

export function deleteByTelegram(tgChatId: string, tgMessageId: number): void {
  db.prepare(
    `DELETE FROM message_links WHERE tg_chat_id = ? AND tg_message_id = ?`,
  ).run(tgChatId, tgMessageId);
}

export function deleteByDiscord(
  discordChannelId: string,
  discordMessageId: string,
): void {
  db.prepare(
    `DELETE FROM message_links
     WHERE discord_channel_id = ? AND discord_message_id = ?`,
  ).run(discordChannelId, discordMessageId);
}
