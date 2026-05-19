import {ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import Config from '../services/config.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove songs from the queue')
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Position of the song to remove [default: 1]')
        .setRequired(false),
    )
    .addIntegerOption(option =>
      option.setName('range')
        .setDescription('Number of songs to remove [default: 1]')
        .setRequired(false));

  private readonly playerManager: PlayerManager;
  private readonly config: Config;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager, @inject(TYPES.Config) config: Config) {
    this.playerManager = playerManager;
    this.config = config;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);

    const position = interaction.options.getInteger('position') ?? 1;
    const range = interaction.options.getInteger('range') ?? 1;

    if (position < 1) {
      throw new Error('Position must be at least 1.');
    }

    if (range < 1) {
      throw new Error('Range must be at least 1.');
    }

    const userId = interaction.user.id;
    const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);
    const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;
    const targetSongs = player.getQueue().slice(position - 1, position - 1 + range);
    const isRequesterOfAll = targetSongs.length > 0 && targetSongs.every(s => s.requestedBy === userId);
    const voiceChannel = (interaction.member as GuildMember).voice.channel;
    const nonBotMembers = voiceChannel && 'members' in voiceChannel
      ? voiceChannel.members.filter((m: GuildMember) => !m.user.bot)
      : null;
    const isAloneInVC = nonBotMembers !== null && nonBotMembers.size === 1 && nonBotMembers.has(userId);

    if (!isInstanceOwner && !hasManageGuild && !isRequesterOfAll && !isAloneInVC) {
      await interaction.reply({content: 'You can only remove your own songs. You need **Manage Server** permission to remove others\'.', flags: MessageFlags.Ephemeral});
      return;
    }

    player.removeFromQueue(position, range);

    await interaction.reply('Removed.');
  }
}
