import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {SlashCommandStringOption} from '@discordjs/builders';

const mocks = vi.hoisted(() => ({youtube: vi.fn()}));
vi.mock('../src/utils/get-youtube-suggestions-for.js', () => ({default: mocks.youtube}));

import Play from '../src/commands/play.js';

const makeInteraction = () => ({options: {getString: () => 'search'}, respond: vi.fn()});
const liveCache = {wrap: (fetch: (...args: unknown[]) => unknown, ...args: unknown[]) => fetch(...args)};
const expectValidChoices = (choices: Array<{name: string; value: string}>) => {
  expect(choices.length).toBeLessThanOrEqual(25);
  expect(() => new SlashCommandStringOption().setName('query').setDescription('query').addChoices(...choices).toJSON()).not.toThrow();
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.youtube.mockResolvedValue([]);
});

describe('/play autocomplete output limits', () => {
  it('bounds provider labels without changing valid query values', async () => {
    mocks.youtube.mockResolvedValue(['q'.repeat(100), 'ordinary query']);
    const interaction = makeInteraction();
    await new Play(liveCache as never, {} as never, {} as never).handleAutocompleteInteraction(interaction as never);
    const choices = interaction.respond.mock.calls[0][0];
    expectValidChoices(choices);
    expect(choices.map((choice: {value: string}) => choice.value)).toEqual(['q'.repeat(100), 'ordinary query']);
  });

  it('normalizes cached results at the response boundary', async () => {
    const suggestions = [
      {name: 'Too long', value: 'q'.repeat(101)},
      {name: 'Spotify: ' + 't'.repeat(150), value: 'spotify:track:unchanged'},
      {name: 'Exact boundary', value: 'q'.repeat(100)},
      {name: 'Ordinary', value: 'ordinary'},
    ];
    const original = structuredClone(suggestions);
    const cache = {wrap: vi.fn().mockResolvedValue(suggestions)};
    const interaction = makeInteraction();

    await new Play(cache as never, {} as never, {} as never).handleAutocompleteInteraction(interaction as never);

    const choices = interaction.respond.mock.calls[0][0];
    expectValidChoices(choices);
    expect(choices.map((choice: {value: string}) => choice.value)).toEqual([
      'spotify:track:unchanged', 'q'.repeat(100), 'ordinary',
    ]);
    expect(suggestions).toEqual(original);
  });
});
