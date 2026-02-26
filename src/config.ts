import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {z} from 'zod';

const BridgeSchema = z.object({
  discord_channel_id: z.string(),
  name: z.string(),
  telegram_chat_id: z.union([z.number(), z.string()]).transform(String),
  telegram_thread_id: z.number().int().optional(),
});

const ConfigFileSchema = z.object({
  bridges: z.array(BridgeSchema).min(1),
});

const EnvSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
});

export type Bridge = z.infer<typeof BridgeSchema>;

export interface Config {
  telegramToken: string;
  discordToken: string;
  bridges: Bridge[];
}

export function loadConfig(): Config {
  // Load tokens from environment
  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    // oxlint-disable-next-line id-length
    const errors = envResult.error.issues.map((i) => i.message).join(', ');
    console.error(`[config] Environment validation failed: ${errors}`);
    process.exit(1);
  }

  // Load bridge mappings from config.yaml
  const configPath = path.resolve(process.env.CONFIG_PATH ?? 'config.yaml');
  if (!fs.existsSync(configPath)) {
    console.error(`[config] config.yaml not found at: ${configPath}`);
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`[config] Failed to parse config.yaml:`, error);
    process.exit(1);
  }

  const fileResult = ConfigFileSchema.safeParse(raw);
  if (!fileResult.success) {
    const errors = fileResult.error.issues
      // oxlint-disable-next-line id-length
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    console.error(`[config] config.yaml validation failed:\n  ${errors}`);
    process.exit(1);
  }

  return {
    bridges: fileResult.data.bridges,
    discordToken: envResult.data.DISCORD_BOT_TOKEN,
    telegramToken: envResult.data.TELEGRAM_BOT_TOKEN,
  };
}
