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
      if (!(await this.safeDeferReply(interaction))) {
        return;
      }

      try {
        // Ensure `/skip 1` skips only the current song
        if (numToSkip === 1) {
          if (!player.canGoForward(1)) {
            throw new Error('No song to skip to.');
          }
          await player.forward(1);
          if (!(await this.safeEditReply(interaction, {
            content: 'Skipped the current song.',
            embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player)] : [],
          }))) {
            return;
          }
        } else {
          // Handle skipping multiple songs
          if (!player.canGoForward(numToSkip)) {
            throw new Error('Not enough songs in the queue to skip.');
          }
          await player.forward(numToSkip);
          if (!(await this.safeEditReply(interaction, {
            content: `Skipped ${numToSkip} song(s).`,
            embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player)] : [],
          }))) {
            return;
          }
        }
      } catch (_: unknown) {
        throw new Error('No song to skip to.');
      }

      return;
    }

    // Non-privileged users: vote to skip (only works for a single song)
    if (numToSkip > 1) {
      await this.safeReply(interaction, {
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
      await this.safeReply(interaction, {
        content: 'You have already voted to skip this song.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    player.addSkipVote(userId);
    const votes = player.getSkipVotes().size;

    if (votes > othersCount / 2) {
      if (!(await this.safeDeferReply(interaction))) {
        return;
      }

      try {
        await player.forward(1);
        await this.safeEditReply(interaction, {
          content: `Vote skip passed (${votes}/${othersCount}). Skipped.`,
          embeds: player.getCurrent() ? [buildPlayingMessageEmbed(player)] : [],
        });
      } catch (_: unknown) {
        throw new Error('No song to skip to.');
      }
    } else {
      const needed = Math.floor(othersCount / 2) + 1;
      await this.safeReply(interaction, {
        content: `Skip vote registered (${votes}/${needed} votes needed).`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private isUnknownInteractionError(error: unknown): boolean {
    const code = (error as {code?: number}).code;
    return code === 10062;
  }

  private async safeDeferReply(interaction: ChatInputCommandInteraction): Promise<boolean> {
    try {
      await interaction.deferReply();
      return true;
    } catch (error: unknown) {
      if (this.isUnknownInteractionError(error)) {
        return false;
      }

      throw error;
    }
  }

  private async safeReply(
    interaction: ChatInputCommandInteraction,
    options: Parameters<ChatInputCommandInteraction['reply']>[0],
  ): Promise<boolean> {
    try {
      await interaction.reply(options);
      return true;
    } catch (error: unknown) {
      if (this.isUnknownInteractionError(error)) {
        return false;
      }

      throw error;
    }
  }

  private async safeEditReply(
    interaction: ChatInputCommandInteraction,
    options: Parameters<ChatInputCommandInteraction['editReply']>[0],
  ): Promise<boolean> {
    try {
      await interaction.editReply(options);
      return true;
    } catch (error: unknown) {
      if (this.isUnknownInteractionError(error)) {
        return false;
      }

      throw error;
    }
  }
}

