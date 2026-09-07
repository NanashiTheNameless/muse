import 'reflect-metadata';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  ffprobe: vi.fn(),
  getSoundCloudMetadata: vi.fn(),
}));

vi.mock('fluent-ffmpeg', () => ({
  default: vi.fn(() => ({
    ffprobe: dependencyMocks.ffprobe,
  })),
}));

vi.mock('../src/services/player.js', () => ({
  MediaSource: {Youtube: 0, HLS: 1, SoundCloud: 2, Arbitrary: 3},
}));

vi.mock('../src/utils/yt-dlp.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/yt-dlp.js')>(),
  getSoundCloudMetadata: dependencyMocks.getSoundCloudMetadata,
}));

import GetSongs from '../src/services/get-songs.js';
import {YtDlpMediaUnavailableError} from '../src/utils/yt-dlp.js';

const makeGetSongsHarness = () => {
  const youtubeAPI = {
    search: vi.fn().mockResolvedValue([]),
    getVideo: vi.fn().mockResolvedValue([]),
    getPlaylist: vi.fn().mockResolvedValue([]),
  };

  return {getSongs: new GetSongs(youtubeAPI as never), youtubeAPI};
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GetSongs SoundCloud routing', () => {
  it.each([
    'https://soundcloud.com/artist/track',
    'https://www.soundcloud.com/artist/track',
    'https://m.soundcloud.com/artist/track',
    'https://on.soundcloud.com/share-id',
    'https://snd.sc/share-id',
  ])('extracts SoundCloud metadata for %s without probing its HTML as audio', async url => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    dependencyMocks.getSoundCloudMetadata.mockResolvedValue({
      title: 'SoundCloud track',
      uploader: 'Uploader',
      duration: 181.7,
      webpage_url: 'https://soundcloud.com/artist/track',
      url: 'https://media.example/expired-signed-audio',
      thumbnail: 'https://images.example/art.jpg',
    });

    await expect(getSongs.getSongs(url, 20, false)).resolves.toEqual([[{
      title: 'SoundCloud track',
      artist: 'Uploader',
      length: 181.7,
      offset: 0,
      url,
      source: 2,
      isLive: false,
      playlist: null,
      thumbnailUrl: 'https://images.example/art.jpg',
    }], '']);
    expect(dependencyMocks.getSoundCloudMetadata).toHaveBeenCalledWith(url, 20);
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it('caps SoundCloud playlists in source order and retains page URLs', async () => {
    const {getSongs} = makeGetSongsHarness();
    const url = 'https://soundcloud.com/artist/sets/album';
    dependencyMocks.getSoundCloudMetadata
      .mockResolvedValueOnce({title: 'Album', entries: [
        {url: 'https://soundcloud.com/artist/first'},
        {url: 'https://soundcloud.com/artist/second'},
      ]})
      .mockResolvedValueOnce({title: 'First', duration: 100});

    const [songs] = await getSongs.getSongs(url, 1, false);

    expect(songs).toEqual([expect.objectContaining({
      title: 'First',
      url: 'https://soundcloud.com/artist/first',
      source: 2,
      length: 100,
      playlist: {title: 'Album', source: url},
    })]);
    expect(dependencyMocks.getSoundCloudMetadata).toHaveBeenCalledWith(url, 1);
    expect(dependencyMocks.getSoundCloudMetadata).toHaveBeenCalledWith('https://soundcloud.com/artist/first', 1);
    expect(dependencyMocks.getSoundCloudMetadata).toHaveBeenCalledTimes(2);
  });

  it('propagates SoundCloud failures without falling back to ffprobe or a YouTube search', async () => {
    const {getSongs, youtubeAPI} = makeGetSongsHarness();
    dependencyMocks.getSoundCloudMetadata.mockRejectedValue(new Error('SoundCloud unavailable'));

    await expect(getSongs.getSongs('https://soundcloud.com/artist/removed', 20, false))
      .rejects.toThrow('SoundCloud unavailable');
    expect(dependencyMocks.ffprobe).not.toHaveBeenCalled();
    expect(youtubeAPI.search).not.toHaveBeenCalled();
  });

  it.each([
    'This video is DRM protected',
    'ERROR: [soundcloud] artist/removed: Unable to download JSON metadata: HTTP Error 404: Not Found',
  ])('retains playable playlist entries when another is unavailable: %s', async detail => {
    const {getSongs} = makeGetSongsHarness();
    dependencyMocks.getSoundCloudMetadata
      .mockResolvedValueOnce({title: 'Album', entries: [
        {url: 'https://soundcloud.com/artist/first'},
        {url: 'https://soundcloud.com/artist/protected'},
        {url: 'https://soundcloud.com/artist/last'},
      ]})
      .mockResolvedValueOnce({title: 'First', duration: 100})
      .mockRejectedValueOnce(new YtDlpMediaUnavailableError(detail))
      .mockResolvedValueOnce({title: 'Last', duration: 200});

    const [songs] = await getSongs.getSongs('https://soundcloud.com/artist/sets/album', 3, false);

    expect(songs.map(song => song.title)).toEqual(['First', 'Last']);
  });
});
