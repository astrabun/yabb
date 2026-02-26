import {Client, GatewayIntentBits, Partials} from 'discord.js';

let client: Client;

export function createDiscordClient(): Client {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
  return client;
}

export function getDiscordClient(): Client {
  if (!client) {
    throw new Error('Discord client not initialized');
  }
  return client;
}
