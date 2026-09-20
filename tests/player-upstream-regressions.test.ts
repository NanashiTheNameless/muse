import {PassThrough, Readable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  entersState: vi.fn(),
  getGuildSettings: vi.fn(),
  joinVoiceChannel: vi.fn(),
  getYouTubeMediaSource: vi.fn(),
}));

vi.mock('@discordjs/voice', async importOriginal => ({
  ...await importOriginal<typeof import('@discordjs/voice')>(),
  entersState: dependencyMocks.entersState,
  joinVoiceChannel: dependencyMocks.joinVoiceChannel,
}));
vi.mock('../src/services/file-cache.js', () => ({default: class {}}));
vi.mock('../src/utils/get-guild-settings.js', () => ({getGuildSettings: dependencyMocks.getGuildSettings}));
vi.mock('../src/utils/build-embed.js', () => ({buildPlayingMessageEmbed: vi.fn()}));
vi.mock('../src/utils/yt-dlp.js', () => ({getYouTubeMediaSource: dependencyMocks.getYouTubeMediaSource}));

import Player, {MediaSource, type QueuedSong} from '../src/services/player.js';

const GUILD_ID = 'guild-id';

beforeEach(() => {
  vi.resetAllMocks();
  dependencyMocks.getGuildSettings.mockResolvedValue({defaultVolume: 100});
  dependencyMocks.entersState.mockResolvedValue(undefined);
});
afterEach(() => {vi.restoreAllMocks();});

const makeDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {promise, reject, resolve};
};

const flushAsyncWork = async () => {
  for (let index = 0; index < 12; index++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};

const makeVoiceConnection = (overrides: Record<string, unknown> = {}) => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const connection = {
    destroy: vi.fn(),
    joinConfig: {channelId: 'voice-channel-id'},
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return connection;
    }),
    receiver: {speaking: {on: vi.fn()}},
    rejoin: vi.fn(() => true),
    rejoinAttempts: 0,
    state: {status: 'ready'},
    subscribe: vi.fn(),
    ...overrides,
  };

  return {connection, handlers};
};

describe('Initial voice handshake retries', () => {
  const channel = {id: 'voice-channel-id', permissionsFor: () => ({has: () => true}), guild: {id: GUILD_ID, members: {me: {}}, voiceAdapterCreator: {}}};
  const makeInitialConnection = (status = 'connecting', networkCode = 0) => {
    const {connection, handlers} = makeVoiceConnection({
      state: {status, networking: {state: {code: networkCode, connectionOptions: {token: 'private-voice-token'}}}},
    });
    connection.destroy.mockImplementation(() => {
      const oldState = connection.state;
      connection.state = {status: 'destroyed'};
      handlers.get('stateChange')?.(oldState, connection.state);
    });
    return connection;
  };

  beforeEach(() => {
    dependencyMocks.joinVoiceChannel.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it.each(['connecting', 'signalling'])('replaces a stalled %s handshake and succeeds on the next join', async status => {
    const first = makeInitialConnection(status);
    const second = makeInitialConnection();
    dependencyMocks.joinVoiceChannel.mockReturnValueOnce(first).mockReturnValueOnce(second);
    dependencyMocks.entersState.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(undefined);
    const player = new Player({} as never, GUILD_ID);

    await player.connect(channel as never);

    expect(dependencyMocks.joinVoiceChannel).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(first.rejoin).not.toHaveBeenCalled();
    expect(second.destroy).not.toHaveBeenCalled();
    expect(player.voiceConnection).toBe(second);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('network state: OpeningWs'));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-voice-token');
  });

  it('bounds repeated failures at three attempts and snapshots diagnostics before destruction', async () => {
    const connections = Array.from({length: 3}, () => makeInitialConnection('connecting', 2));
    connections.forEach(connection => dependencyMocks.joinVoiceChannel.mockReturnValueOnce(connection));
    dependencyMocks.entersState.mockRejectedValue(new Error('timeout'));
    const player = new Player({} as never, GUILD_ID);

    await expect(player.connect(channel as never)).rejects.toThrow(
      'last state: connecting, network state: UdpHandshaking, attempt: 3/3, rejoin attempts: 0, recent states: connecting',
    );

    expect(dependencyMocks.joinVoiceChannel).toHaveBeenCalledTimes(3);
    expect(dependencyMocks.entersState.mock.calls.map(call => call[2])).toEqual([20_000, 20_000, 20_000]);
    connections.forEach(connection => expect(connection.destroy).toHaveBeenCalledOnce());
    expect(player.voiceConnection).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('shares a pending join between concurrent requests for the same channel', async () => {
    const ready = makeDeferred<void>();
    const connection = makeInitialConnection();
    dependencyMocks.joinVoiceChannel.mockReturnValue(connection);
    dependencyMocks.entersState.mockReturnValue(ready.promise);
    const player = new Player({} as never, GUILD_ID);
    const first = player.connect(channel as never);
    await flushAsyncWork();
    const second = player.connect(channel as never);
    ready.resolve(undefined);
    await Promise.all([first, second]);

    expect(dependencyMocks.joinVoiceChannel).toHaveBeenCalledOnce();
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('does not retry or reconnect after an explicit disconnect during the Ready wait', async () => {
    const ready = makeDeferred<void>();
    const connection = makeInitialConnection();
    dependencyMocks.joinVoiceChannel.mockReturnValue(connection);
    dependencyMocks.entersState.mockReturnValue(ready.promise);
    const player = new Player({} as never, GUILD_ID);
    const connecting = player.connect(channel as never);
    await flushAsyncWork();
    player.disconnect();
    ready.reject(new Error('destroyed'));
    await expect(connecting).rejects.toThrow('Failed to connect');

    expect(dependencyMocks.joinVoiceChannel).toHaveBeenCalledOnce();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(player.voiceConnection).toBeNull();
  });

  it('cancels a pending settings lookup before it can join or replace a newer connection', async () => {
    const settings = makeDeferred<object>();
    dependencyMocks.getGuildSettings.mockReturnValueOnce(settings.promise);
    const connection = makeInitialConnection();
    dependencyMocks.joinVoiceChannel.mockReturnValue(connection);
    const player = new Player({} as never, GUILD_ID);
    const first = player.connect(channel as never);
    await player.connect({...channel, id: 'new-channel'} as never);
    settings.resolve({defaultVolume: 100});
    await expect(first).rejects.toThrow('cancelled');

    expect(dependencyMocks.joinVoiceChannel).toHaveBeenCalledOnce();
    expect(player.voiceConnection).toBe(connection);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('waits through an initial connection replacement instead of waiting on its destroyed predecessor', async () => {
    const ready = makeDeferred<void>();
    const first = makeInitialConnection();
    const second = makeInitialConnection();
    dependencyMocks.joinVoiceChannel.mockReturnValueOnce(first).mockReturnValueOnce(second);
    dependencyMocks.entersState.mockReturnValueOnce(ready.promise).mockResolvedValue(undefined);
    const player = new Player({} as never, GUILD_ID);
    const connecting = player.connect(channel as never);
    await flushAsyncWork();
    const waiting = player.ensureVoiceConnectionReady();
    ready.reject(new Error('timeout'));
    await connecting;

    await expect(waiting).resolves.toBe(second);
    expect(dependencyMocks.entersState.mock.calls.map(call => call[0])).toEqual([first, second, second]);
  });

  it('rejects a stale readiness wait without returning an unchecked replacement', async () => {
    const ready = makeDeferred<void>();
    dependencyMocks.entersState.mockReturnValue(ready.promise);
    const oldConnection = makeInitialConnection();
    const newConnection = makeInitialConnection();
    const player = new Player({} as never, GUILD_ID);
    player.voiceConnection = oldConnection as never;
    const waiting = player.ensureVoiceConnectionReady();
    player.voiceConnection = newConnection as never;
    ready.resolve(undefined);

    await expect(waiting).rejects.toThrow('Voice connection changed');
    expect(newConnection.destroy).not.toHaveBeenCalled();
  });

});

describe('bounded media cache identity', () => {
  it('does not reuse a cached first chapter as the complete recording', async () => {
    dependencyMocks.getYouTubeMediaSource.mockResolvedValue({url: 'https://media.example/audio.webm', isLive: false, headers: {}});
    const entries = new Map<string, {path: string; generation: string}>();
    const fileCache = {getEntryFor: vi.fn(async (key: string) => entries.get(key) ?? null)};
    const player = new Player(fileCache as never, GUILD_ID);
    const createReadStream = vi.fn(async () => new PassThrough());
    Object.assign(player, {createReadStream});
    const song: QueuedSong = {title: 'First chapter', artist: 'Artist', url: 'abcdefghijk', length: 30,
      offset: 0, playlist: null, isLive: false, thumbnailUrl: null, source: MediaSource.Youtube,
      addedInChannelId: 'text-id', requestedBy: 'user-id'};
    const getStream = (player as unknown as {getStream(song: QueuedSong, options: {seek: number; to: number}): Promise<Readable>}).getStream.bind(player);
    (await getStream(song, {seek: 0, to: 30})).destroy();
    entries.set(fileCache.getEntryFor.mock.calls[0][0], {path: '/cache/first-chapter.webm', generation: 'chapter'});
    (await getStream({...song, title: 'Complete recording', length: 180}, {seek: 0, to: 180})).destroy();
    expect(createReadStream).toHaveBeenLastCalledWith(expect.objectContaining({url: 'https://media.example/audio.webm'}));
    expect(dependencyMocks.getYouTubeMediaSource).toHaveBeenCalledTimes(2);
    entries.set(fileCache.getEntryFor.mock.calls[1][0], {path: '/cache/complete.webm', generation: 'full'});
    (await getStream({...song, length: 180}, {seek: 60, to: 180})).destroy();
    expect(createReadStream).toHaveBeenLastCalledWith(expect.objectContaining({url: '/cache/complete.webm', ffmpegInputOptions: ['-ss', '60', '-to', '180']}));
  });
});
