import getYouTubeID from './get-youtube-id.js';
import {truncate} from './string.js';
import {MediaSource, SongMetadata} from '../services/player.js';

const getMaxSongTitleLength = (title: string) => {
  // eslint-disable-next-line no-control-regex
  const nonASCII = /[^\x00-\x7F]+/;
  return nonASCII.test(title) ? 28 : 48;
};

const cleanTitle = (title: string) => title.replace(/\[.*\]/, '').trim();

export const getSongTitle = ({title, url, offset, source}: SongMetadata, shouldTruncate = false) => {
  const cleanSongTitle = source === MediaSource.HLS ? title : cleanTitle(title);
  const songTitle = truncate(cleanSongTitle, shouldTruncate ? getMaxSongTitleLength(cleanSongTitle) : 256);
  if (source === MediaSource.HLS || source === MediaSource.SoundCloud || source === MediaSource.Arbitrary) {
    return url.length > 1024 ? songTitle : `[${songTitle}](<${url}>)`;
  }

  const youtubeId = url.length === 11 ? url : getYouTubeID(url) ?? '';

  return `[${songTitle}](<https://www.youtube.com/watch?v=${youtubeId}${offset === 0 ? '' : '&t=' + String(offset)}>)`;
};
