import {AutocompleteInteraction, ChatInputCommandInteraction} from 'discord.js';
import {URL} from 'url';
import {SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder} from '@discordjs/builders';
import {inject, injectable} from 'inversify';
import Command from './index.js';
import {TYPES} from '../types.js';
import getYouTubeCommandSuggestionsFor from '../utils/get-youtube-command-suggestions-for.js';
import KeyValueCacheProvider from '../services/key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import AddQueryToQueue from '../services/add-query-to-queue.js';

@injectable()
export default class implements Command {
  public readonly slashCommand: Partial<SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder> & Pick<SlashCommandBuilder, 'toJSON'>;

  public requiresVC = true;

  private readonly cache: KeyValueCacheProvider;
  private readonly addQueryToQueue: AddQueryToQueue;

  constructor(@inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider, @inject(TYPES.Services.AddQueryToQueue) addQueryToQueue: AddQueryToQueue) {
    this.cache = cache;
    this.addQueryToQueue = addQueryToQueue;

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

    await this.addQueryToQueue.addToQueue({
      interaction,
      query: query.trim(),
      addToFrontOfQueue: interaction.options.getBoolean('immediate') ?? false,
      shuffleAdditions: interaction.options.getBoolean('shuffle') ?? false,
      shouldSplitChapters: interaction.options.getBoolean('split') ?? false,
      skipCurrentTrack: interaction.options.getBoolean('skip') ?? false,
    });
  }

  public async handleAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getString('query')?.trim();

    if (!query || query.length === 0) {
      await interaction.respond([]);
      return;
    }

    try {
      // Don't return suggestions for URLs
      // eslint-disable-next-line no-new
      new URL(query);
      await interaction.respond([]);
      return;
    } catch {}

    const suggestions = await this.cache.wrap(
      getYouTubeCommandSuggestionsFor,
      query,
      10,
      {
        expiresIn: ONE_HOUR_IN_SECONDS,
        key: `autocomplete:${query}`,
      });

    await interaction.respond(suggestions);
  }
}
