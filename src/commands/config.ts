import {SlashCommandBuilder} from '@discordjs/builders';
import {ChatInputCommandInteraction, EmbedBuilder, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
import {inject, injectable} from 'inversify';
import {prisma} from '../utils/db.js';
import Command from './index.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {TYPES} from '../types.js';
import Config from '../services/config.js';

@injectable()
export default class implements Command {
  private readonly config: Config;

  constructor(@inject(TYPES.Config) config: Config) {
    this.config = config;
  }

  public readonly slashCommand = new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure bot settings')
    .addSubcommand(subcommand => subcommand
      .setName('set-playlist-limit')
      .setDescription('Set the maximum number of tracks that can be added from a playlist')
      .addIntegerOption(option => option
        .setName('limit')
        .setDescription('Maximum number of tracks')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-wait-after-queue-empties')
      .setDescription('Set the time to wait before leaving the voice channel when queue empties')
      .addIntegerOption(option => option
        .setName('delay')
        .setDescription('Delay in seconds (set to 0 to never leave)')
        .setRequired(true)
        .setMinValue(0)))
    .addSubcommand(subcommand => subcommand
      .setName('set-leave-if-no-listeners')
      .setDescription('Set whether to leave when all other participants leave')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('Whether to leave when everyone else leaves')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-duck')
      .setDescription('Set whether to turn down the volume when non-bot users speak')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('Whether to turn down the volume when people speak')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-duck-target')
      .setDescription('Set the target volume when people speak')
      .addIntegerOption(option => option
        .setName('volume')
        .setDescription('Volume percentage (0 is muted, 100 is max & default)')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-auto-announce-next-song')
      .setDescription('Set whether to announce the next song in the queue automatically')
      .addBooleanOption(option => option
        .setName('value')
        .setDescription('Whether to announce the next song in the queue automatically')
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-default-volume')
      .setDescription('Set default volume used when entering the voice channel')
      .addIntegerOption(option => option
        .setName('level')
        .setDescription('Volume percentage (0 is muted, 100 is max & default)')
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('set-default-queue-page-size')
      .setDescription('Set the default page size of the /queue command')
      .addIntegerOption(option => option
        .setName('page-size')
        .setDescription('Page size of the /queue command')
        .setMinValue(1)
        .setMaxValue(30)
        .setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('get')
      .setDescription('Show all settings'));

  async execute(interaction: ChatInputCommandInteraction) {
    const isInstanceOwner = interaction.user.id === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && interaction.user.id === this.config.INSTANCE_OWNER_ID);
    const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;

    if (!isInstanceOwner && !hasManageGuild) {
      await interaction.reply({content: 'You need the **Manage Server** permission to use this command.', flags: MessageFlags.Ephemeral});
      return;
    }

    // Ensure guild settings exist before trying to update
    await getGuildSettings(interaction.guild!.id);

    // Defer the interaction to allow longer processing without timing out.
    // We'll use `editReply` to send the final response.
    await interaction.deferReply();

    switch (interaction.options.getSubcommand()) {
      case 'set-playlist-limit': {
        const limit: number = interaction.options.getInteger('limit')!;

        if (limit < 1) {
          throw new Error('Invalid limit.');
        }

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            playlistLimit: limit,
          },
        });

        await interaction.editReply('Limit updated.');

        break;
      }

      case 'set-wait-after-queue-empties': {
        const delay = interaction.options.getInteger('delay')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            secondsToWaitAfterQueueEmpties: delay,
          },
        });

        await interaction.editReply('Wait delay updated.');

        break;
      }

      case 'set-leave-if-no-listeners': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            leaveIfNoListeners: value,
          },
        });

        await interaction.editReply('Leave setting updated.');

        break;
      }


      case 'set-auto-announce-next-song': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            autoAnnounceNextSong: value,
          },
        });

        await interaction.editReply('Auto announce setting updated.');

        break;
      }

      case 'set-default-volume': {
        const value = interaction.options.getInteger('level')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            defaultVolume: value,
          },
        });

        await interaction.editReply('Volume setting updated.');

        break;
      }

      case 'set-default-queue-page-size': {
        const value = interaction.options.getInteger('page-size')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            defaultQueuePageSize: value,
          },
        });

        await interaction.editReply('Default queue page size updated.');

        break;
      }

      case 'set-duck': {
        const value = interaction.options.getBoolean('value')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            volumeDucking: value,
          },
        });

        await interaction.editReply('Turn down volume setting updated.');

        break;
      }

      case 'set-duck-target': {
        const value = interaction.options.getInteger('volume')!;

        await prisma.setting.update({
          where: {
            guildId: interaction.guild!.id,
          },
          data: {
            volumeDuckingTarget: value,
          },
        });

        await interaction.editReply('Turn down volume target setting updated.');

        break;
      }
      

      case 'get': {
        const embed = new EmbedBuilder().setTitle('Config');

        const config = await getGuildSettings(interaction.guild!.id);

        const settingsToShow = {
          'Playlist Limit': config.playlistLimit,
          'Wait before leaving after queue empty': config.secondsToWaitAfterQueueEmpties === 0
            ? 'Never leave'
            : `${config.secondsToWaitAfterQueueEmpties}s`,
          'Leave if there are no listeners': config.leaveIfNoListeners ? 'Yes' : 'No',
          'Auto announce next song in queue': config.autoAnnounceNextSong ? 'Yes' : 'No',
          'Default Volume': config.defaultVolume,
          'Default queue page size': config.defaultQueuePageSize,
          'Reduce volume when people speak': config.volumeDucking ? 'Yes' : 'No',
        };

        let description = '';
        for (const [key, value] of Object.entries(settingsToShow)) {
          description += `**${key}**: ${value}\n`;
        }

        embed.setDescription(description);

        await interaction.editReply({embeds: [embed]});

        break;
      }

      default:
        throw new Error('Unknown subcommand.');
    }
  }
}
