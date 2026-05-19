import {inject, injectable} from 'inversify';
import {ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import Command from './index.js';
import Config from '../services/config.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear all songs in queue except currently playing song');

  public requiresVC = true;

  private readonly playerManager: PlayerManager;
  private readonly config: Config;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager, @inject(TYPES.Config) config: Config) {
    this.playerManager = playerManager;
    this.config = config;
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    const userId = interaction.user.id;
    const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);
    const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;

    const voiceChannel = (interaction.member as GuildMember).voice.channel;
    const nonBotMembers = voiceChannel && 'members' in voiceChannel
      ? voiceChannel.members.filter((m: GuildMember) => !m.user.bot)
      : null;
    const isAloneInVC = nonBotMembers !== null && nonBotMembers.size === 1 && nonBotMembers.has(userId);

    if (!isInstanceOwner && !hasManageGuild && !isAloneInVC) {
      await interaction.reply({content: 'You need the **Manage Server** permission to clear the queue.', flags: MessageFlags.Ephemeral});
      return;
    }

    this.playerManager.get(interaction.guild!.id).clear();

    await interaction.reply('Cleared the queue.');
  }
}
