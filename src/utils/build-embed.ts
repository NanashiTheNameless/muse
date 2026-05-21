import {EmbedBuilder} from 'discord.js';
import Player, {STATUS, PlayerPublic} from '../services/player.js';
import getProgressBar from './get-progress-bar.js';
import {prettyTime} from './time.js';
import {getSongTitle} from './song-title.js';

const getQueueInfo = (player: Player) => {
  const queueSize = player.queueSize();
  if (queueSize === 0) {
    return '-';
  }

  return queueSize === 1 ? '1 song' : `${queueSize} songs`;
};

const getPlayerUI = (player: PlayerPublic) => {
  const song = player.getCurrent();

  if (!song) {
    return '';
  }

  const rawPosition = player.getPosition();
  const position = Math.max(0, Math.min(rawPosition, song.length));
  const indicator = player.status === STATUS.PLAYING ? '[playing]' : '[stopped]';
  const progressBar = getProgressBar(10, position / song.length);
  const elapsedTime = song.isLive ? 'live' : `${prettyTime(position)}/${prettyTime(song.length)}`;
  const loop = player.loopCurrentSong ? '[loop-song]' : player.loopCurrentQueue ? '[loop-queue]' : '';
  let vol: string;
  let overrideText = '';

  if (player.isVolumeOverridden() && player.getPreDuckingVolume() !== null) {
    // Show the user's configured volume as the primary value and append the
    // current effective (ducked) volume as the override info so the UI isn't
    // confusing when people are speaking.
    vol = `${player.getPreDuckingVolume()}%`;
    overrideText = ` (overridden to ${player.getVolume()}% due to speaking)`;
  } else {
    vol = typeof player.getVolume() === 'number' ? `${player.getVolume()!}%` : '';
  }

  return `${indicator} ${progressBar} \`[${elapsedTime}]\` vol ${vol}${overrideText} ${loop}`;
};

export const buildPlayingMessageEmbed = (player: Player): EmbedBuilder => {
  const currentlyPlaying = player.getCurrent();

  if (!currentlyPlaying) {
    throw new Error('No playing song found.');
  }

  const {artist, thumbnailUrl, requestedBy} = currentlyPlaying;
  const message = new EmbedBuilder();
  message
    .setColor(player.status === STATUS.PLAYING ? 'DarkGreen' : 'DarkRed')
    .setTitle(player.status === STATUS.PLAYING ? 'Now Playing' : 'Paused')
    .setDescription(`
      **${getSongTitle(currentlyPlaying)}**
      Requested by: <@${requestedBy}>\n
      ${getPlayerUI(player)}
    `)
    .setFooter({text: `Source: ${artist}`});

  if (thumbnailUrl) {
    message.setThumbnail(thumbnailUrl);
  }

  return message;
};

export const buildQueueEmbed = (player: Player, page: number, pageSize: number): EmbedBuilder => {
  const currentlyPlaying = player.getCurrent();

  if (!currentlyPlaying) {
    throw new Error('Queue is empty.');
  }

  const queueSize = player.queueSize();
  const maxQueuePage = Math.ceil((queueSize + 1) / pageSize);

  if (page > maxQueuePage) {
    throw new Error('The queue is not that big.');
  }

  const queuePageBegin = (page - 1) * pageSize;
  const queuePageEnd = queuePageBegin + pageSize;
  const queuedSongs = player
    .getQueue()
    .slice(queuePageBegin, queuePageEnd)
    .map((song, index) => {
      const songNumber = index + 1 + queuePageBegin;
      const duration = song.isLive ? 'live' : prettyTime(song.length);

      return `\`${songNumber}.\` ${getSongTitle(song, true)} \`[${duration}]\``;
    })
    .join('\n');

  const {artist, thumbnailUrl, playlist, requestedBy} = currentlyPlaying;
  const playlistTitle = playlist ? `(${playlist.title})` : '';
  const totalLength = player.getQueue().reduce((accumulator, current) => accumulator + current.length, 0);

  const message = new EmbedBuilder();

  let description = `**${getSongTitle(currentlyPlaying)}**\n`;
  description += `Requested by: <@${requestedBy}>\n\n`;
  description += `${getPlayerUI(player)}\n\n`;

  if (player.getQueue().length > 0) {
    description += '**Up next:**\n';
    description += queuedSongs;
  }

  message
    .setTitle(player.status === STATUS.PLAYING ? `Now Playing ${player.loopCurrentSong ? '(loop on)' : ''}` : 'Queued songs')
    .setColor(player.status === STATUS.PLAYING ? 'DarkGreen' : 'NotQuiteBlack')
    .setDescription(description)
    .addFields([{name: 'In queue', value: getQueueInfo(player), inline: true}, {
      name: 'Total length', value: `${totalLength > 0 ? prettyTime(totalLength) : '-'}`, inline: true,
    }, {name: 'Page', value: `${page} out of ${maxQueuePage}`, inline: true}])
    .setFooter({text: `Source: ${artist} ${playlistTitle}`});

  if (thumbnailUrl) {
    message.setThumbnail(thumbnailUrl);
  }

  return message;
};
