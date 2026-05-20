import {ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import Config from '../services/config.js';
import {getSongTitle} from '../utils/song-title.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move songs within the queue')
    .addIntegerOption(option =>
      option.setName('from')
        .setDescription('Position of the song to move')
        .setRequired(true),
    )
    .addIntegerOption(option =>
      option.setName('to')
        .setDescription('Position to move the song to')
        .setRequired(true));

  private readonly playerManager: PlayerManager;
  private readonly config: Config;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager, @inject(TYPES.Config) config: Config) {
    this.playerManager = playerManager;
    this.config = config;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);

    const from = interaction.options.getInteger('from') ?? 1;
    const to = interaction.options.getInteger('to') ?? 1;

    if (from < 1) {
      throw new Error('Position must be at least 1.');
    }

    if (to < 1) {
      throw new Error('Position must be at least 1.');
    }

    const userId = interaction.user.id;
    const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);
    const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;
    const fromSong = player.getQueue()[from - 1];
    const toSong = player.getQueue()[to - 1];
    const isRequesterOfFrom = fromSong?.requestedBy === userId;
    const isRequesterOfTo = toSong?.requestedBy === userId;
    const voiceChannel = (interaction.member as GuildMember).voice.channel;
    const nonBotMembers = voiceChannel && 'members' in voiceChannel
      ? voiceChannel.members.filter((m: GuildMember) => !m.user.bot)
      : null;
    const isAloneInVC = nonBotMembers !== null && nonBotMembers.size === 1 && nonBotMembers.has(userId);

    if (!isInstanceOwner && !hasManageGuild && !isAloneInVC) {
      if (!isRequesterOfFrom) {
        await interaction.reply({content: 'You can only move your own songs.', flags: MessageFlags.Ephemeral});
        return;
      }

      if (!isRequesterOfTo) {
        await interaction.reply({content: 'You cannot move to a position occupied by another user\'s song.', flags: MessageFlags.Ephemeral});
        return;
      }
    }

    const song = player.move(from, to);

    await interaction.reply(`Moved **${getSongTitle(song)}** to position **${String(to)}**.`);
  }
}
