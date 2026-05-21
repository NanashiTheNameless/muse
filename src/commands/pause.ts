import {ChatInputCommandInteraction, MessageFlags} from 'discord.js';
import {SlashCommandBuilder} from '@discordjs/builders';
import {TYPES} from '../types.js';
import {inject, injectable} from 'inversify';
import PlayerManager from '../managers/player.js';
import Player, {STATUS} from '../services/player.js';
import Command from './index.js';

@injectable()
export default class implements Command {
  public readonly slashCommand = new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song');

  public requiresVC = true;

  private readonly playerManager: PlayerManager;

  constructor(@inject(TYPES.Managers.Player) playerManager: PlayerManager) {
    this.playerManager = playerManager;
  }

  public async execute(interaction: ChatInputCommandInteraction) {
    const player = this.playerManager.get(interaction.guild!.id);

    try {
      if (player.status !== STATUS.PLAYING) {
        await interaction.reply({content: 'Not currently playing.', flags: MessageFlags.Ephemeral});
        return;
      }

      player.pause();
      const ttlMinutes = Math.round(Player.PAUSE_RESOURCE_TTL_MS / 60000);
      await interaction.reply(
        `Paused playback. The audio resource will be torn down after ${ttlMinutes} minutes while paused to conserve CPU and network resources. If the resource is torn down you may notice a short delay and rebuffering when you resume — the player will recreate the stream and resume from the same position for on-demand tracks. To avoid rebuffering, avoid long pauses or use stop/play instead of extended pauses.`
      );
    } catch (error: unknown) {
      await interaction.reply({content: (error as Error).message ?? 'An error occurred while pausing.', flags: MessageFlags.Ephemeral});
    }
  }
}
