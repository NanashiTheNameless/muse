import {APIApplicationCommandOptionChoice} from 'discord-api-types/v10';
import getYouTubeSuggestionsFor from './get-youtube-suggestions-for.js';
import {truncate} from './string.js';

const DISCORD_CHOICE_LIMIT = 100;

const getYouTubeCommandSuggestionsFor = async (query: string, limit = 10): Promise<APIApplicationCommandOptionChoice[]> => {
  const youtubeSuggestions = await getYouTubeSuggestionsFor(query);

  return youtubeSuggestions
    .slice(0, limit)
    .map(suggestion => ({
      name: truncate(`YouTube: ${suggestion}`, DISCORD_CHOICE_LIMIT),
      value: truncate(suggestion, DISCORD_CHOICE_LIMIT),
    }));
};

export default getYouTubeCommandSuggestionsFor;
