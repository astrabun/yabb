import {Bot} from 'grammy';

let bot: Bot;

export function createBot(token: string): Bot {
  bot = new Bot(token);
  return bot;
}

export function getBot(): Bot {
  if (!bot) {
    throw new Error('Telegram bot not initialized');
  }
  return bot;
}
