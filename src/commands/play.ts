import {AutocompleteInteraction, ChatInputCommandInteraction, VoiceChannel, GuildMember} from 'discord.js';
import {URL} from 'url';
import {SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder} from '@discordjs/builders';
import {inject, injectable} from 'inversify';
import Command from './index.js';
import {TYPES} from '../types.js';
import getYouTubeCommandSuggestionsFor from '../utils/get-youtube-command-suggestions-for.js';
import KeyValueCacheProvider from '../services/key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';
import Config from '../services/config.js';
import {getSizeWithoutBots} from '../utils/channels.js';

@injectable()
export default class implements Command {
  public readonly slashCommand: any;

  public requiresVC = true;

  private readonly cache: KeyValueCacheProvider;
  private readonly addQueryToQueue: AddQueryToQueue;
  private readonly config: Config;

  constructor(@inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider, @inject(TYPES.Services.AddQueryToQueue) addQueryToQueue: AddQueryToQueue, @inject(TYPES.Config) config: Config) {
    this.cache = cache;
    this.addQueryToQueue = addQueryToQueue;
    this.config = config;

    this.slashCommand = new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a song')
      .addStringOption(option => option
        .setName('query')
        .setDescription('YouTube URL or search query')
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption(option => option
        .setName('immediate')
        .setDescription('Add track to the front of the queue'))
      .addBooleanOption(option => option
        .setName('shuffle')
        .setDescription('Shuffle the input if you\'re adding multiple tracks'))
      .addBooleanOption(option => option
        .setName('split')
        .setDescription('If a track has chapters, split it'))
      .addBooleanOption(option => option
        .setName('skip')
        .setDescription('Skip the currently playing track'));
  }

  public async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const query = interaction.options.getString('query')!;
    const immediate = interaction.options.getBoolean('immediate') ?? false;

    // Check immediate permission
    if (immediate) {
      const userId = interaction.user.id;
      const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);

      if (!isInstanceOwner) {
        const voiceChannel = (interaction.member instanceof GuildMember) ? interaction.member.voice?.channel as VoiceChannel | undefined : undefined;
        const membersInChannel = voiceChannel ? getSizeWithoutBots(voiceChannel) : 0;

        if (membersInChannel > 1) {
          throw new Error('You can only use `/play immediate` if you are the only one in the voice channel, or if you are the instance owner.');
        }
      }
    }

    await this.addQueryToQueue.addToQueue({
      interaction,
      query: query.trim(),
      addToFrontOfQueue: immediate,
      shuffleAdditions: interaction.options.getBoolean('shuffle') ?? false,
      shouldSplitChapters: interaction.options.getBoolean('split') ?? false,
      skipCurrentTrack: interaction.options.getBoolean('skip') ?? false,
    });
  }

  public async handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getString('query')?.trim();

    if (!query || query.length === 0) {
      await this.respondToAutocomplete(interaction, []);
      return;
    }

    let queryProtocol: string | undefined;
    try {
      queryProtocol = new URL(query).protocol;
    } catch {}

    // Don't return suggestions for supported provider URLs
    if (queryProtocol && ['http:', 'https:'].includes(queryProtocol)) {
      await this.respondToAutocomplete(interaction, []);
      return;
    }

    const suggestions = await this.cache.wrap(
      getYouTubeCommandSuggestionsFor,
      query,
      10,
      {
        expiresIn: ONE_HOUR_IN_SECONDS,
        key: `autocomplete:${query}`,
      });

    await this.respondToAutocomplete(interaction, suggestions);
  }

  private async respondToAutocomplete(interaction: AutocompleteInteraction, suggestions: {name: string; value: string | number}[]): Promise<void> {
    try {
      await interaction.respond(suggestions);
    } catch (error: unknown) {
      const code = (error as {code?: number}).code;
      // Users can type quickly and invalidate an autocomplete interaction before we answer.
      if (code === 10062) {
        return;
      }

      throw error;
    }
  }
}
