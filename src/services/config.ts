import dotenv from 'dotenv';
import 'reflect-metadata';
import {injectable} from 'inversify';
import path from 'path';
import xbytes from 'xbytes';
import {ConditionalKeys} from 'type-fest';
dotenv.config({path: process.env.ENV_FILE ?? path.resolve(process.cwd(), '.env')});

export const DATA_DIR = path.resolve(process.env.DATA_DIR ? process.env.DATA_DIR : './data');

const firstNonEmpty = (...values: Array<string | undefined>) => values
  .map(value => value?.trim())
  .find((value): value is string => Boolean(value));

const CONFIG_MAP = {
  DISCORD_TOKEN: firstNonEmpty(process.env.DISCORD_TOKEN),
  YOUTUBE_API_KEY: firstNonEmpty(process.env.YOUTUBE_API_KEY),
  REGISTER_COMMANDS_ON_BOT: process.env.REGISTER_COMMANDS_ON_BOT === 'true',
  DATA_DIR,
  CACHE_DIR: path.join(DATA_DIR, 'cache'),
  CACHE_LIMIT_IN_BYTES: xbytes.parseSize(process.env.CACHE_LIMIT ?? '2GB'),
  ENABLE_SPONSORBLOCK: process.env.ENABLE_SPONSORBLOCK === 'true',
  SPONSORBLOCK_TIMEOUT: parseInt(process.env.SPONSORBLOCK_TIMEOUT ?? '5', 10),
  YT_DLP_PATH: firstNonEmpty(process.env.YT_DLP_PATH, process.env.MUSE_BUNDLED_YT_DLP_PATH) ?? 'yt-dlp',
  YT_DLP_AUTO_UPDATE: process.env.YT_DLP_AUTO_UPDATE !== 'false',
  YT_DLP_COOKIES_PATH: process.env.YT_DLP_COOKIES_PATH ?? '',
  INSTANCE_OWNER_ID: process.env.INSTANCE_OWNER_ID ?? '',
} as const;

@injectable()
export default class Config {
  readonly DISCORD_TOKEN!: string;
  readonly YOUTUBE_API_KEY!: string;
  readonly REGISTER_COMMANDS_ON_BOT!: boolean;
  readonly DATA_DIR!: string;
  readonly CACHE_DIR!: string;
  readonly CACHE_LIMIT_IN_BYTES!: number;
  readonly ENABLE_SPONSORBLOCK!: boolean;
  readonly SPONSORBLOCK_TIMEOUT!: number;
  readonly YT_DLP_PATH!: string;
  readonly YT_DLP_AUTO_UPDATE!: boolean;
  readonly YT_DLP_COOKIES_PATH!: string;
  readonly INSTANCE_OWNER_ID!: string;

  constructor() {
    for (const [key, value] of Object.entries(CONFIG_MAP)) {
      if (typeof value === 'undefined') {
        console.error(`Missing environment variable for ${key}`);
        process.exit(1);
      }

      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error(`Invalid numeric value for ${key}`);
        }

        if (key === 'CACHE_LIMIT_IN_BYTES' && value < 0) {
          throw new Error('Invalid numeric value for CACHE_LIMIT_IN_BYTES: value must be non-negative');
        }

        this[key as ConditionalKeys<typeof CONFIG_MAP, number>] = value;
      } else if (typeof value === 'string') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        (this as any)[key] = value.trim();
      } else if (typeof value === 'boolean') {
        this[key as ConditionalKeys<typeof CONFIG_MAP, boolean>] = value;
      } else {
        throw new Error(`Unsupported type for ${key}`);
      }
    }
  }
}
