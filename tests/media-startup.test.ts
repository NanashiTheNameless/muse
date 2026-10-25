import 'reflect-metadata';
import {PassThrough, Readable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  createAudioPlayer: vi.fn(),
  createAudioResource: vi.fn(),
  debug: vi.fn(),
  entersState: vi.fn(),
  execa: vi.fn(),
  ffmpeg: vi.fn(),
  getGuildSettings: vi.fn(),
  joinVoiceChannel: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock('@discordjs/voice', () => ({
  AudioPlayerStatus: {Idle: 'idle'},
  VoiceConnectionDisconnectReason: {WebSocketClose: 'websocket-close'},
  VoiceConnectionStatus: {
    Connecting: 'connecting',
    Disconnected: 'disconnected',
    Destroyed: 'destroyed',
    Ready: 'ready',
    Signalling: 'signalling',
  },
  NetworkingStatusCode: {0: 'OpeningWs', 2: 'UdpHandshaking'},
  StreamType: {WebmOpus: 'webm-opus'},
  createAudioPlayer: dependencyMocks.createAudioPlayer,
  createAudioResource: dependencyMocks.createAudioResource,
  entersState: dependencyMocks.entersState,
  joinVoiceChannel: dependencyMocks.joinVoiceChannel,
}));

vi.mock('timers/promises', () => ({
  setTimeout: dependencyMocks.sleep,
}));

vi.mock('execa', () => ({
  execa: dependencyMocks.execa,
}));

vi.mock('fluent-ffmpeg', () => ({
  default: dependencyMocks.ffmpeg,
}));

vi.mock('prism-media', async () => {
  const {Transform} = await import('node:stream');

  return {
    default: {
      opus: {
        WebmDemuxer: class extends Transform {
          _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
            if (chunk.includes(1)) {
              this.push(Buffer.from([0xf8, 0xff, 0xfe]));
            }

            done();
          }
        },
      },
    },
  };
});

vi.mock('../src/services/file-cache.js', () => ({
  default: class {},
}));

vi.mock('../src/utils/build-embed.js', () => ({
  buildQueueEmbed: vi.fn(() => ({title: 'queue'})),
  buildPlayingMessageEmbed: vi.fn(() => ({title: 'playing'})),
}));

vi.mock('../src/utils/get-guild-settings.js', () => ({
  getGuildSettings: dependencyMocks.getGuildSettings,
}));

vi.mock('../src/utils/debug.js', () => ({
  default: dependencyMocks.debug,
}));

import Player, {
  FfmpegMediaUnavailableError,
  FfmpegStartupError,
  MediaSource,
  QueuedSong,
  STATUS,
} from '../src/services/player.js';
import {getSoundCloudMetadata, getSoundCloudMediaSource, getYouTubeMediaSource} from '../src/utils/yt-dlp.js';

const GUILD_ID = 'guild-id';
const ORIGINAL_ENV = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  MUSE_BUNDLED_YT_DLP_PATH: process.env.MUSE_BUNDLED_YT_DLP_PATH,
  PATH: process.env.PATH,
  SPOTIFY_CLIENT_ID: process.env.SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET: process.env.SPOTIFY_CLIENT_SECRET,
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  YT_DLP_COOKIES_PATH: process.env.YT_DLP_COOKIES_PATH,
  YT_DLP_PATH: process.env.YT_DLP_PATH,
};
const VALID_MEDIA_RESPONSE = JSON.stringify({
  requested_downloads: [{
    url: 'https://media.example/requested.webm',
    http_headers: {
      Authorization: 'Bearer media-token',
      'User-Agent': 'Muse ops test',
      Empty: '',
      Missing: null,
    },
  }],
  http_headers: {'X-Fallback': 'not-used'},
  is_live: true,
});

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

const makeFfmpegCommand = ({deferProcessResult = false, emptyOutput = false, hangOutput = false, headerOnlyOutput = false, startupError, startupErrorAfterOutput}: {
  deferProcessResult?: boolean;
  emptyOutput?: boolean;
  hangOutput?: boolean;
  headerOnlyOutput?: boolean;
  startupError?: Error;
  startupErrorAfterOutput?: Error;
} = {}) => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const command = {
    audioCodec: vi.fn(() => command),
    inputOptions: vi.fn(() => command),
    kill: vi.fn(),
    noVideo: vi.fn(() => command),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return command;
    }),
    outputFormat: vi.fn(() => command),
    pipe: vi.fn((destination: {end(): void; write(chunk: Buffer): void}) => {
      if (startupError) {
        handlers.get('error')?.(startupError);
        return destination;
      }

      if (hangOutput) {
        return destination;
      }

      if (!emptyOutput) {
        destination.write(Buffer.from([headerOnlyOutput ? 2 : 1]));
      }
      destination.end();
      if (deferProcessResult) {
        return destination;
      } else if (startupErrorAfterOutput) {
        handlers.get('error')?.(startupErrorAfterOutput);
      } else {
        handlers.get('end')?.();
      }
      return destination;
    }),
    triggerError: (error: Error) => handlers.get('error')?.(error),
    triggerStart: () => handlers.get('start')?.(),
  };

  return command;
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

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.YT_DLP_COOKIES_PATH;
  delete process.env.YT_DLP_PATH;
  delete process.env.MUSE_BUNDLED_YT_DLP_PATH;
  dependencyMocks.execa.mockResolvedValue({stdout: VALID_MEDIA_RESPONSE});
  dependencyMocks.ffmpeg.mockImplementation(makeFfmpegCommand);
  dependencyMocks.getGuildSettings.mockResolvedValue({
    defaultVolume: 100,
    turnDownVolumeWhenPeopleSpeak: false,
  });
  dependencyMocks.entersState.mockResolvedValue(undefined);
  dependencyMocks.sleep.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();

  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('checked media extraction', () => {
  it.each(['youtube', 'soundcloud'])('checks %s formats and bounds the unchecked fallback', async source => {
    dependencyMocks.execa
      .mockRejectedValueOnce({stderr: 'Requested format is not available'})
      .mockResolvedValueOnce({stdout: VALID_MEDIA_RESPONSE});
    await (source === 'youtube' ? getYouTubeMediaSource('abcdefghijk') : getSoundCloudMediaSource('https://soundcloud.com/artist/track'));
    expect(dependencyMocks.execa).toHaveBeenCalledTimes(2);
    expect(dependencyMocks.execa.mock.calls[0][1]).toContain('--check-formats');
    expect(dependencyMocks.execa.mock.calls[1][1]).toContain('--no-check-formats');
  });

  it('does not probe flat playlist metadata', async () => {
    dependencyMocks.execa.mockResolvedValueOnce({stdout: '{"entries":[]}'});
    await getSoundCloudMetadata('https://soundcloud.com/artist/sets/album', 10);
    expect(dependencyMocks.execa).toHaveBeenCalledOnce();
    expect(dependencyMocks.execa.mock.calls[0][1]).not.toContain('--check-formats');
  });
});

describe('media startup, retries, and prefetch', () => {
  it('rejects an FFmpeg startup failure before reporting a playable stream and redacts the signed URL', async () => {
    process.env.YT_DLP_PATH = '/fake/yt-dlp';
    const signedUrl = 'HTTPS://media.example/requested.webm?token=secret';
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      startupError: new Error(`${signedUrl}: Server returned 404 Not Found`),
    }));
    const fileCache = {
      getEntryFor: vi.fn().mockResolvedValue(null),
    };
    const player = new Player(fileCache as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Rejected media URL',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 3_600,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const result = (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);

    await expect(result).rejects.toEqual(expect.objectContaining({
      name: 'FfmpegMediaUnavailableError',
      message: expect.stringContaining('[media URL]'),
    }));
    await expect(result).rejects.not.toEqual(expect.objectContaining({
      message: expect.stringContaining('token=secret'),
    }));
    await expect(result).rejects.toBeInstanceOf(FfmpegMediaUnavailableError);
  });

  it('rejects an empty FFmpeg output instead of reporting playback', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({emptyOutput: true}));
    const player = new Player({
      getEntryFor: vi.fn().mockResolvedValue({generation: 'cached-generation', path: '/cached/audio.webm'}),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Empty media output',
      artist: 'Artist',
      url: 'https://media.example/empty.webm',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.HLS,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const result = (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);
    await expect(result).rejects.toMatchObject({
      name: 'FfmpegMediaUnavailableError',
      message: expect.stringContaining('produced no playable Opus audio'),
    });
  });

  it('preserves a startup timeout for retry instead of skipping the queue', async () => {
    vi.useFakeTimers();
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({hangOutput: true}));
    const player = new Player({
      getEntryFor: vi.fn().mockResolvedValue({generation: 'cached-generation', path: '/cached/audio.webm'}),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Slow startup',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const result = (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);
    const expectation = expect(result).rejects.toMatchObject({
      name: 'FfmpegStartupError',
      message: expect.stringContaining('within 20 seconds'),
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;

    const command = dependencyMocks.ffmpeg.mock.results[0].value as ReturnType<typeof makeFfmpegCommand>;
    const killsBeforeLateStart = command.kill.mock.calls.length;
    command.triggerStart();
    expect(command.kill).toHaveBeenCalledTimes(killsBeforeLateStart + 1);
    expect(command.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('waits for the FFmpeg result before classifying output EOF', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      emptyOutput: true,
      startupErrorAfterOutput: new Error('Server returned 403 Forbidden'),
    }));
    const player = new Player({
      getEntryFor: vi.fn().mockResolvedValue({generation: 'cached-generation', path: '/cached/audio.webm'}),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'EOF before process result',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    await expect((player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song)).rejects.toBeInstanceOf(FfmpegStartupError);
  });

  it('does not accept a container header without a playable Opus packet', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      headerOnlyOutput: true,
    }));
    const player = new Player({
      getEntryFor: vi.fn().mockResolvedValue({generation: 'cached-generation', path: '/cached/audio.webm'}),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Header-only output',
      artist: 'Artist',
      url: 'https://media.example/header-only.webm',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.HLS,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    await expect((player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song)).rejects.toBeInstanceOf(FfmpegMediaUnavailableError);
  });

  it('invalidates a corrupt cached input and retries from a fresh media URL', async () => {
    dependencyMocks.ffmpeg
      .mockImplementationOnce(() => makeFfmpegCommand({headerOnlyOutput: true}))
      .mockImplementationOnce(() => makeFfmpegCommand());
    const invalidate = vi.fn().mockResolvedValue(undefined);
    const player = new Player({
      getEntryFor: vi.fn()
        .mockResolvedValueOnce({generation: 'corrupt-generation', path: '/cached/corrupt.webm'})
        .mockResolvedValueOnce(null),
      invalidate,
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Corrupt cached input',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 3_600,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);

    expect(invalidate).toHaveBeenCalledWith(expect.any(String), 'corrupt-generation');
    expect(dependencyMocks.ffmpeg).toHaveBeenNthCalledWith(1, '/cached/corrupt.webm');
    expect(dependencyMocks.ffmpeg).toHaveBeenNthCalledWith(2, 'https://media.example/requested.webm');
    stream.destroy();
  });

  it('preserves infrastructure-level FFmpeg startup failures', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      startupError: new Error('spawn ffmpeg ENOENT'),
    }));
    const player = new Player({
      getEntryFor: vi.fn().mockResolvedValue({generation: 'cached-generation', path: '/cached/audio.webm'}),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Host failure',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    await expect((player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song)).rejects.toBeInstanceOf(FfmpegStartupError);
  });

  it('preserves transient HTTP failures for retry instead of skipping the queue', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      startupError: new Error('Server returned 403 Forbidden'),
    }));
    const player = new Player({
      getEntryFor: vi.fn().mockResolvedValue({generation: 'cached-generation', path: '/cached/audio.webm'}),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Transient media failure',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    await expect((player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song)).rejects.toBeInstanceOf(FfmpegStartupError);
  });

  const makeUncachedYouTubeSong = (title: string): QueuedSong => ({
    title,
    artist: 'Artist',
    url: 'abcdefghijk',
    length: 3_600,
    offset: 0,
    playlist: null,
    isLive: false,
    thumbnailUrl: null,
    source: MediaSource.Youtube,
    addedInChannelId: 'text-channel-id',
    requestedBy: 'requester-id',
  });

  it('waits until the yt-dlp available_at time before handing the URL to FFmpeg', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));
    const nowSeconds = Math.floor(Date.now() / 1000);
    dependencyMocks.execa.mockResolvedValue({
      stdout: JSON.stringify({
        requested_downloads: [{url: 'https://media.example/requested.webm', available_at: nowSeconds + 9}],
      }),
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const order: string[] = [];
    dependencyMocks.sleep.mockImplementation(async () => {
      order.push('sleep');
    });
    dependencyMocks.ffmpeg.mockImplementation(() => {
      order.push('ffmpeg');
      return makeFfmpegCommand();
    });
    const player = new Player({getEntryFor: vi.fn().mockResolvedValue(null)} as never, GUILD_ID);

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(makeUncachedYouTubeSong('Delayed media'));

    expect(dependencyMocks.sleep).toHaveBeenCalledWith(10_000);
    expect(order).toEqual(['sleep', 'ffmpeg']);
    stream.destroy();
  });

  it('does not wait when available_at is already in the past', async () => {
    dependencyMocks.execa.mockResolvedValue({
      stdout: JSON.stringify({
        requested_downloads: [{url: 'https://media.example/requested.webm', available_at: Math.floor(Date.now() / 1000) - 60}],
      }),
    });
    const player = new Player({getEntryFor: vi.fn().mockResolvedValue(null)} as never, GUILD_ID);

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(makeUncachedYouTubeSong('Available media'));

    expect(dependencyMocks.sleep).not.toHaveBeenCalled();
    stream.destroy();
  });

  it('retries the same media URL after a startup 403 instead of failing immediately', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dependencyMocks.ffmpeg
      .mockImplementationOnce(() => makeFfmpegCommand({startupError: new Error('Server returned 403 Forbidden (access denied)')}))
      .mockImplementationOnce(() => makeFfmpegCommand());
    const player = new Player({getEntryFor: vi.fn().mockResolvedValue(null)} as never, GUILD_ID);

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(makeUncachedYouTubeSong('Briefly forbidden media'));

    expect(dependencyMocks.sleep).toHaveBeenCalledWith(5_000);
    expect(dependencyMocks.ffmpeg).toHaveBeenCalledTimes(2);
    expect(dependencyMocks.ffmpeg).toHaveBeenNthCalledWith(2, 'https://media.example/requested.webm');
    expect(dependencyMocks.execa).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    stream.destroy();
  });

  it('surfaces a persistent 403 as a startup error after bounded retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      startupError: new Error('Server returned 403 Forbidden (access denied)'),
    }));
    const player = new Player({getEntryFor: vi.fn().mockResolvedValue(null)} as never, GUILD_ID);

    await expect((player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(makeUncachedYouTubeSong('Forbidden media'))).rejects.toMatchObject({
      name: 'FfmpegStartupError',
      forbidden: true,
    });
    expect(dependencyMocks.sleep.mock.calls).toEqual([[5_000], [10_000]]);
    expect(dependencyMocks.ffmpeg).toHaveBeenCalledTimes(3);
  });

  describe('delayed media startup cancellation', () => {
    const makeStartupPlayer = () => {
      vi.useFakeTimers({toFake: ['Date', 'setInterval', 'clearInterval']});
      vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      dependencyMocks.createAudioPlayer.mockImplementation(() => ({
        listeners: vi.fn(() => []), on: vi.fn(), play: vi.fn(), pause: vi.fn(), stop: vi.fn(),
      }));
      dependencyMocks.createAudioResource.mockImplementation((sourceStream: Readable) => ({
        sourceStream, volume: {setVolume: vi.fn()},
      }));
      const player = new Player({getEntryFor: vi.fn().mockResolvedValue(null)} as never, GUILD_ID);
      const {connection} = makeVoiceConnection();
      const song = makeUncachedYouTubeSong('Delayed startup');
      player.voiceConnection = connection as never;
      player.add(song);
      return {player, connection, song};
    };

    const holdMediaSleep = (delayMs: number) => {
      const started = makeDeferred<void>();
      const release = makeDeferred<void>();
      dependencyMocks.sleep.mockImplementation(async (ms: number) => {
        if (ms === delayMs) {
          started.resolve();
          await release.promise;
        }
      });
      return {started: started.promise, release: () => release.resolve()};
    };

    const delayNextMedia = () => {
      dependencyMocks.execa.mockResolvedValueOnce({stdout: JSON.stringify({
        url: 'https://media.example/delayed.webm', available_at: Date.now() / 1000 + 19,
      })});
    };

    const rejectNextMedia = () => {
      dependencyMocks.ffmpeg.mockImplementationOnce(() => makeFfmpegCommand({
        startupError: new Error('Server returned 403 Forbidden'),
      }));
    };

    it('does not start FFmpeg after stop during the availability wait in play', async () => {
      const {player, connection} = makeStartupPlayer();
      delayNextMedia();
      const wait = holdMediaSleep(20_000);
      const playing = player.play();
      await wait.started;
      expect(dependencyMocks.ffmpeg).not.toHaveBeenCalled();

      player.stop();
      wait.release();
      await playing;

      expect(player.getCurrent()).toBeNull();
      expect(player.voiceConnection).toBeNull();
      expect(connection.subscribe).not.toHaveBeenCalled();
      expect(dependencyMocks.createAudioPlayer).not.toHaveBeenCalled();
      expect(dependencyMocks.ffmpeg).not.toHaveBeenCalled();
    });

    it('does not start seek media after disconnect during its availability wait', async () => {
      const {player, connection, song} = makeStartupPlayer();
      await player.play();
      delayNextMedia();
      const wait = holdMediaSleep(20_000);
      const seeking = player.seek(30);
      await wait.started;

      player.disconnect();
      wait.release();
      await seeking;

      expect(player.getCurrent()).toBe(song);
      expect(player.getPosition()).toBe(0);
      expect(player.status).toBe(STATUS.PAUSED);
      expect(player.voiceConnection).toBeNull();
      expect(connection.subscribe).toHaveBeenCalledOnce();
      expect(dependencyMocks.createAudioPlayer).toHaveBeenCalledOnce();
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledOnce();
    });

    it('keeps newer playback when an older availability wait finishes', async () => {
      const {player, connection, song} = makeStartupPlayer();
      delayNextMedia();
      const wait = holdMediaSleep(20_000);
      const olderPlaying = player.play();
      await wait.started;
      await player.play();
      const newerAudio = dependencyMocks.createAudioPlayer.mock.results[0].value;
      const newerResource = dependencyMocks.createAudioResource.mock.results[0].value;

      wait.release();
      await olderPlaying;

      expect(player.getCurrent()).toBe(song);
      expect(player.status).toBe(STATUS.PLAYING);
      expect(connection.subscribe).toHaveBeenCalledExactlyOnceWith(newerAudio);
      expect(newerAudio.play).toHaveBeenCalledExactlyOnceWith(newerResource);
      expect(newerAudio.stop).not.toHaveBeenCalled();
      expect(newerResource.sourceStream.destroyed).toBe(false);
      expect(dependencyMocks.createAudioPlayer).toHaveBeenCalledOnce();
      player.stop();
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledOnce();
    });

    it('does not retry after stop during the first 403 backoff', async () => {
      const {player, connection} = makeStartupPlayer();
      rejectNextMedia();
      const wait = holdMediaSleep(5_000);
      const playing = player.play();
      await wait.started;
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledOnce();

      player.stop();
      wait.release();
      await playing;

      expect(player.getCurrent()).toBeNull();
      expect(player.voiceConnection).toBeNull();
      expect(connection.subscribe).not.toHaveBeenCalled();
      expect(dependencyMocks.createAudioPlayer).not.toHaveBeenCalled();
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledOnce();
      expect(dependencyMocks.sleep.mock.calls).toEqual([[5_000]]);
    });

    it('does not run the final 403 retry after newer playback takes ownership', async () => {
      const {player, connection, song} = makeStartupPlayer();
      rejectNextMedia();
      rejectNextMedia();
      const wait = holdMediaSleep(10_000);
      const olderPlaying = player.play();
      await wait.started;
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledTimes(2);
      await player.play();
      const newerAudio = dependencyMocks.createAudioPlayer.mock.results[0].value;
      const newerResource = dependencyMocks.createAudioResource.mock.results[0].value;

      wait.release();
      await olderPlaying;

      expect(player.getCurrent()).toBe(song);
      expect(player.status).toBe(STATUS.PLAYING);
      expect(connection.subscribe).toHaveBeenCalledExactlyOnceWith(newerAudio);
      expect(newerAudio.play).toHaveBeenCalledExactlyOnceWith(newerResource);
      expect(newerAudio.stop).not.toHaveBeenCalled();
      expect(newerResource.sourceStream.destroyed).toBe(false);
      expect(dependencyMocks.createAudioPlayer).toHaveBeenCalledOnce();
      player.stop();
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledTimes(3);
      expect(dependencyMocks.sleep.mock.calls).toEqual([[5_000], [10_000]]);
    });

    it('still starts playback when both bounded 403 backoffs complete with ownership intact', async () => {
      const {player, connection, song} = makeStartupPlayer();
      rejectNextMedia();
      rejectNextMedia();
      const wait = holdMediaSleep(10_000);
      const playing = player.play();
      await wait.started;
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledTimes(2);
      expect(connection.subscribe).not.toHaveBeenCalled();

      wait.release();
      await playing;

      expect(player.getCurrent()).toBe(song);
      expect(player.status).toBe(STATUS.PLAYING);
      expect(connection.subscribe).toHaveBeenCalledOnce();
      expect(dependencyMocks.ffmpeg).toHaveBeenCalledTimes(3);
      expect(dependencyMocks.sleep.mock.calls).toEqual([[5_000], [10_000]]);
      player.stop();
    });
  });

  const makePrefetchPlayer = () => {
    const player = new Player({getEntryFor: vi.fn().mockResolvedValue(null)} as never, GUILD_ID);
    const current = makeUncachedYouTubeSong('Current');
    const next = {...makeUncachedYouTubeSong('Next'), url: 'nextvideo01'};
    player.add(current);
    player.add(next);
    const internals = player as unknown as {
      positionInSeconds: number;
      prefetchNextSongIfDue(): void;
      getStream(input: QueuedSong): Promise<Readable>;
    };

    return {internals, next};
  };

  it('prefetches the next song near the end of the current one and reuses the URL', async () => {
    const {internals, next} = makePrefetchPlayer();

    internals.positionInSeconds = 3_600 - 120;
    internals.prefetchNextSongIfDue();
    expect(dependencyMocks.execa).not.toHaveBeenCalled();

    internals.positionInSeconds = 3_600 - 60;
    internals.prefetchNextSongIfDue();
    internals.prefetchNextSongIfDue();
    expect(dependencyMocks.execa).toHaveBeenCalledOnce();
    expect(dependencyMocks.execa.mock.calls[0][1].at(-1)).toBe('https://www.youtube.com/watch?v=nextvideo01');

    const stream = await internals.getStream(next);

    expect(dependencyMocks.execa).toHaveBeenCalledOnce();
    expect(dependencyMocks.ffmpeg).toHaveBeenCalledWith('https://media.example/requested.webm');
    stream.destroy();
  });

  it('extracts again when the prefetch failed', async () => {
    dependencyMocks.execa.mockRejectedValueOnce({stderr: 'ERROR: transient extractor failure'});
    const {internals, next} = makePrefetchPlayer();

    internals.positionInSeconds = 3_600 - 10;
    internals.prefetchNextSongIfDue();
    const stream = await internals.getStream(next);

    expect(dependencyMocks.execa).toHaveBeenCalledTimes(2);
    expect(dependencyMocks.ffmpeg).toHaveBeenCalledWith('https://media.example/requested.webm');
    stream.destroy();
  });

  it('extracts again when the prefetched URL is too old', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    const {internals, next} = makePrefetchPlayer();

    internals.positionInSeconds = 3_600 - 10;
    internals.prefetchNextSongIfDue();
    await flushAsyncWork();
    vi.setSystemTime(Date.now() + (11 * 60 * 1000));
    const stream = await internals.getStream(next);

    expect(dependencyMocks.execa).toHaveBeenCalledTimes(2);
    stream.destroy();
  });

  it('destroys an in-progress cache destination when FFmpeg fails during startup', async () => {
    dependencyMocks.execa.mockResolvedValue({
      stdout: JSON.stringify({
        ...JSON.parse(VALID_MEDIA_RESPONSE),
        is_live: false,
      }),
    });
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({
      startupError: new Error('Server returned 404 Not Found'),
    }));
    const cacheDestination = new PassThrough();
    const destroyCacheDestination = vi.spyOn(cacheDestination, 'destroy');
    const player = new Player({
      createWriteStream: vi.fn(() => cacheDestination),
      getEntryFor: vi.fn().mockResolvedValue(null),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Cacheable rejected media',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    await expect((player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song)).rejects.toBeInstanceOf(FfmpegMediaUnavailableError);
    expect(destroyCacheDestination).toHaveBeenCalledOnce();
  });

  it('finalizes a cache write only after FFmpeg exits successfully', async () => {
    dependencyMocks.execa.mockResolvedValue({
      stdout: JSON.stringify({
        ...JSON.parse(VALID_MEDIA_RESPONSE),
        is_live: false,
      }),
    });
    const cacheDestination = new PassThrough();
    const endCacheDestination = vi.spyOn(cacheDestination, 'end');
    const player = new Player({
      createWriteStream: vi.fn(() => cacheDestination),
      getEntryFor: vi.fn().mockResolvedValue(null),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Successful cache media',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);
    await vi.waitFor(() => {
      expect(endCacheDestination).toHaveBeenCalledOnce();
    });
    stream.destroy();
  });

  it('discards an in-progress cache if FFmpeg fails after the first playable packet', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({deferProcessResult: true}));
    dependencyMocks.execa.mockResolvedValue({
      stdout: JSON.stringify({
        ...JSON.parse(VALID_MEDIA_RESPONSE),
        is_live: false,
      }),
    });
    const cacheDestination = new PassThrough();
    const destroyCacheDestination = vi.spyOn(cacheDestination, 'destroy');
    const player = new Player({
      createWriteStream: vi.fn(() => cacheDestination),
      getEntryFor: vi.fn().mockResolvedValue(null),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Partially playable media',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);
    const command = dependencyMocks.ffmpeg.mock.results[0].value as ReturnType<typeof makeFfmpegCommand>;
    command.triggerError(new Error('Server returned 403 Forbidden'));
    await flushAsyncWork();

    expect(destroyCacheDestination).toHaveBeenCalledOnce();
    stream.destroy();
  });

  it('discards an in-progress cache if FFmpeg fails after the playback reader closes', async () => {
    dependencyMocks.ffmpeg.mockImplementation(() => makeFfmpegCommand({deferProcessResult: true}));
    dependencyMocks.execa.mockResolvedValue({
      stdout: JSON.stringify({
        ...JSON.parse(VALID_MEDIA_RESPONSE),
        is_live: false,
      }),
    });
    const cacheDestination = new PassThrough();
    const destroyCacheDestination = vi.spyOn(cacheDestination, 'destroy');
    const player = new Player({
      createWriteStream: vi.fn(() => cacheDestination),
      getEntryFor: vi.fn().mockResolvedValue(null),
    } as never, GUILD_ID);
    const song: QueuedSong = {
      title: 'Stopped partial media',
      artist: 'Artist',
      url: 'abcdefghijk',
      length: 100,
      offset: 0,
      playlist: null,
      isLive: false,
      thumbnailUrl: null,
      source: MediaSource.Youtube,
      addedInChannelId: 'text-channel-id',
      requestedBy: 'requester-id',
    };

    const stream = await (player as unknown as {
      getStream(input: QueuedSong): Promise<Readable>;
    }).getStream(song);
    const command = dependencyMocks.ffmpeg.mock.results[0].value as ReturnType<typeof makeFfmpegCommand>;
    stream.destroy();
    command.triggerError(new Error('Server returned 403 Forbidden'));
    await flushAsyncWork();

    expect(destroyCacheDestination).toHaveBeenCalledOnce();
  });
});
