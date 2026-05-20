import {prisma} from './db.js';
import {createGuildSettings} from '../events/guild-create.js';

export type GuildSettings = NonNullable<Awaited<ReturnType<typeof prisma.setting.findUnique>>>;

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const config = await prisma.setting.findUnique({where: {guildId}});
  if (!config) {
    return createGuildSettings(guildId);
  }

  return config;
}
