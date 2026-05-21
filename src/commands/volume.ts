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
    .setName('volume')
    .setDescription('Adjust playback volume')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set the current playback volume (real-time)')
      .addIntegerOption(opt => opt.setName('level').setDescription('Volume percent 0-100').setRequired(true).setMinValue(0).setMaxValue(100)))
    .addSubcommand(sub => sub
      .setName('get')
      .setDescription('Get the current playback volume'));

  private readonly playerManager: PlayerManager;
  private readonly config: Config;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager, @inject(TYPES.Config) config: Config) {
    this.playerManager = playerManager;
    this.config = config;
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = this.playerManager.get(interaction.guild!.id);

    const userId = interaction.user.id;
    const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);
    const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;

    const voiceChannel = (interaction.member as GuildMember).voice.channel;
    const nonBotMembers = voiceChannel && 'members' in voiceChannel
      ? voiceChannel.members.filter((m: GuildMember) => !m.user.bot)
      : null;
    const isAloneInVC = nonBotMembers !== null && nonBotMembers.size === 1 && nonBotMembers.has(userId);

    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const level = interaction.options.getInteger('level')!;

      // permission: instance owner OR manage guild OR alone in VC
      if (!isInstanceOwner && !hasManageGuild && !isAloneInVC) {
        await interaction.reply({content: 'You need Manage Server permission (or be alone in VC) to change volume.', flags: MessageFlags.Ephemeral});
        return;
      }

      player.setVolume(level);

      await interaction.reply(`Volume set to **${level}%**`);
      return;
    }

    // get
    const current = player.getVolume();
    await interaction.reply(`Current volume: **${current}%**`);
  }
}
