import {inject, injectable} from 'inversify';
import {SongMetadata, MediaSource} from './player.js';
import {TYPES} from '../types.js';
import ffmpeg from 'fluent-ffmpeg';
import YoutubeAPI from './youtube-api.js';
import {URL} from 'node:url';
import getYouTubeID from '../utils/get-youtube-id.js';
import {cleanUrl} from '../utils/url.js';

@injectable()
export default class {
  private readonly youtubeAPI: YoutubeAPI;

  constructor(@inject(TYPES.Services.YoutubeAPI) youtubeAPI: YoutubeAPI) {
    this.youtubeAPI = youtubeAPI;
  }

  async getSongs(query: string, _playlistLimit: number, shouldSplitChapters: boolean): Promise<[SongMetadata[], string]> {
    const newSongs: SongMetadata[] = [];
    const extraMsg = '';
    let url: URL | undefined;

    // Test if it's a complete URL
    try {
      url = new URL(query);
    } catch {
      url = undefined;
    }

    const supportedProtocols = ['http:', 'https:'];

    if (!url || !supportedProtocols.includes(url.protocol)) {
      // Not a supported provider URL, so search YouTube as free text.
      const songs = await this.youtubeVideoSearch(query, shouldSplitChapters);

      if (songs) {
        newSongs.push(...songs);
      } else {
        throw new Error('That does not exist.');
      }

      return [newSongs, extraMsg];
    }

    const YOUTUBE_HOSTS = [
      'www.youtube.com',
      'youtu.be',
      'youtube.com',
      'music.youtube.com',
      'www.music.youtube.com',
    ];

    if (YOUTUBE_HOSTS.includes(url.host)) {
      const cleanedUrl = cleanUrl(url.href);
      // If a playlist param is present, treat the URL as a playlist even when a video id is also present.
      if (url.searchParams.get('list')) {
        // YouTube playlist
        newSongs.push(...await this.youtubePlaylist(url.searchParams.get('list')!, shouldSplitChapters));
      } else {
        const videoId = getYouTubeID(cleanedUrl);

        if (videoId) {
          const songs = await this.youtubeVideo(cleanedUrl, shouldSplitChapters);

          if (songs) {
            newSongs.push(...songs);
          } else {
            throw new Error('That does not exist.');
          }
        } else {
          throw new Error('That does not exist.');
        }
      }
    } else {
      const song = await this.arbitraryUrl(query);

      if (song) {
        newSongs.push(song);
      } else {
        throw new Error('That does not exist.');
      }
    }

    return [newSongs, extraMsg];
  }

  private async youtubeVideoSearch(query: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.search(query, shouldSplitChapters);
  }

  private async youtubeVideo(url: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.getVideo(url, shouldSplitChapters);
  }

  private async youtubePlaylist(listId: string, shouldSplitChapters: boolean): Promise<SongMetadata[]> {
    return this.youtubeAPI.getPlaylist(listId, shouldSplitChapters);
  }

  private async arbitraryUrl(url: string): Promise<SongMetadata> {
    const titleFromUrl = () => {
      try {
        const filename = new URL(url).pathname.split('/').pop();
        return filename ? decodeURIComponent(filename).replace(/\.[^.]+$/, '') : url;
      } catch {
        return url;
      }
    };

    const hostnameFromUrl = () => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    };

    return new Promise(resolve => {
      ffmpeg(url).ffprobe((err, data) => {
        if (err || !data) {
          // ffprobe failed - play the URL anyway with unknown metadata
          resolve({
            url,
            source: MediaSource.Arbitrary,
            isLive: false,
            title: titleFromUrl(),
            artist: hostnameFromUrl(),
            length: 0,
            offset: 0,
            playlist: null,
            thumbnailUrl: null,
          });
          return;
        }

        const duration = typeof data.format?.duration === 'number' ? Math.ceil(data.format.duration) : 0;
        const isLive = duration === 0;
        const tags = (data.format?.tags ?? {}) as Record<string, string>;
        const filenameTitle = titleFromUrl();
        const title = filenameTitle || tags.title;
        const artist = tags.artist ?? tags.album_artist ?? new URL(url).hostname;

        resolve({
          url,
          source: isLive ? MediaSource.HLS : MediaSource.Arbitrary,
          isLive,
          title,
          artist,
          length: duration,
          offset: 0,
          playlist: null,
          thumbnailUrl: null,
        });
      });
    });
  }
}
