import {ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import Config from '../services/config.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the next songs')
    .addIntegerOption(option => option
      .setName('number')
      .setDescription('Number of songs to skip [default: 1]')
      .setRequired(false));

  public requiresVC = true;

  private readonly playerManager: PlayerManager;
  private readonly config: Config;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager, @inject(TYPES.Config) config: Config) {
    this.playerManager = playerManager;
    this.config = config;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const numToSkip = interaction.options.getInteger('number') ?? 1;

    if (numToSkip < 1) {
      throw new Error('Invalid number of songs to skip.');
    }

    const player = this.playerManager.get(interaction.guild!.id);
    const currentSong = player.getCurrent();

    if (!currentSong) {
      throw new Error('No song to skip to.');
    }

    const userId = interaction.user.id;
    const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);
    const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;
    const isRequester = userId === currentSong.requestedBy;

    const voiceChannel = (interaction.member as GuildMember).voice.channel;
    const nonBotMembers = voiceChannel && 'members' in voiceChannel
      ? voiceChannel.members.filter((m: GuildMember) => !m.user.bot)
      : null;
    const isAloneInVC = nonBotMembers !== null && nonBotMembers.size === 1 && nonBotMembers.has(userId);

    if (isInstanceOwner || hasManageGuild || isRequester || isAloneInVC) {
      await interaction.deferReply();
      try {
        await player.forward(numToSkip);
        await interaction.editReply({
          content: 'Skipped.',
          embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player)] : [],
        });
      } catch (_: unknown) {
        throw new Error('No song to skip to.');
      }

      return;
    }

    // Non-privileged users: vote to skip (only works for a single song)
    if (numToSkip > 1) {
      await interaction.reply({
        content: 'You need Manage Server permission or to have requested the song to skip multiple songs.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!nonBotMembers) {
      throw new Error('Could not determine voice channel members.');
    }

    // "Other users" excludes the requester since they can skip directly
    const othersCount = nonBotMembers.filter((m: GuildMember) => m.id !== currentSong.requestedBy).size;

    if (player.getSkipVotes().has(userId)) {
      await interaction.reply({
        content: 'You have already voted to skip this song.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    player.addSkipVote(userId);
    const votes = player.getSkipVotes().size;

    if (votes > othersCount / 2) {
      await interaction.deferReply();
      try {
        await player.forward(1);
        await interaction.editReply({
          content: `Vote skip passed (${votes}/${othersCount}). Skipped.`,
          embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player)] : [],
        });
      } catch (_: unknown) {
        throw new Error('No song to skip to.');
      }
    } else {
      const needed = Math.floor(othersCount / 2) + 1;
      await interaction.reply({
        content: `Skip vote registered (${votes}/${needed} votes needed).`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

