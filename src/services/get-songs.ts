import {inject, injectable} from 'inversify';
import {SongMetadata, MediaSource} from './player.js';
import {TYPES} from '../types.js';
import ffmpeg from 'fluent-ffmpeg';
import YoutubeAPI from './youtube-api.js';
import {URL} from 'node:url';
import getYouTubeID from '../utils/get-youtube-id.js';

@injectable()
export default class {
  private readonly youtubeAPI: YoutubeAPI;

  constructor(@inject(TYPES.Services.YoutubeAPI) youtubeAPI: YoutubeAPI) {
    this.youtubeAPI = youtubeAPI;
  }

  async getSongs(query: string, _playlistLimit: number, shouldSplitChapters: boolean): Promise<[SongMetadata[], string]> {
    const newSongs: SongMetadata[] = [];
    const extraMsg = '';
    let url: URL;

    // Test if it's a complete URL
    try {
      url = new URL(query);
    } catch {
      // Not a URL, must search YouTube
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
      const videoId = getYouTubeID(url.href);

      if (videoId) {
        const songs = await this.youtubeVideo(url.href, shouldSplitChapters);

        if (songs) {
          newSongs.push(...songs);
        } else {
          throw new Error('That does not exist.');
        }
      } else if (url.searchParams.get('list')) {
        // YouTube playlist
        newSongs.push(...await this.youtubePlaylist(url.searchParams.get('list')!, shouldSplitChapters));
      } else {
        throw new Error('That does not exist.');
      }
    } else {
      const song = await this.httpLiveStream(query);

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

  private async httpLiveStream(url: string): Promise<SongMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg(url).ffprobe((err, _) => {
        if (err) {
          reject();
        }

        resolve({
          url,
          source: MediaSource.HLS,
          isLive: true,
          title: url,
          artist: url,
          length: 0,
          offset: 0,
          playlist: null,
          thumbnailUrl: null,
        });
      });
    });
  }
}
