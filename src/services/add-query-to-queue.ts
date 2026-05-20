import {ChatInputCommandInteraction, GuildMember, MessageFlags} from 'discord.js';
import {inject, injectable} from 'inversify';
import shuffle from 'array-shuffle';
import {TYPES} from '../types.js';
import GetSongs from '../services/get-songs.js';
import {MediaSource, SongMetadata, STATUS} from './player.js';
import PlayerManager from '../managers/player.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {SponsorBlock} from 'sponsorblock-api';
import Config from './config.js';
import KeyValueCacheProvider from './key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import debug from '../utils/debug.js';
import {getSongTitle} from '../utils/song-title.js';

@injectable()
export default class AddQueryToQueue {
  private readonly sponsorBlock?: SponsorBlock;
  private sponsorBlockDisabledUntil?: Date;
  private readonly sponsorBlockTimeoutDelay;
  private readonly cache: KeyValueCacheProvider;

  constructor(@inject(TYPES.Services.GetSongs) private readonly getSongs: GetSongs,
    @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Config) private readonly config: Config,
    @inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider) {
    this.sponsorBlockTimeoutDelay = config.SPONSORBLOCK_TIMEOUT;
    this.sponsorBlock = config.ENABLE_SPONSORBLOCK
      ? new SponsorBlock('muse-sb-integration') // UserID matters only for submissions
      : undefined;
    this.cache = cache;
  }

  public async addToQueue({
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
    skipCurrentTrack,
    interaction,
  }: {
    query: string;
    addToFrontOfQueue: boolean;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
    skipCurrentTrack: boolean;
    interaction: ChatInputCommandInteraction;
  }): Promise<void> {
    const guildId = interaction.guild!.id;
    const player = this.playerManager.get(guildId);
    const wasPlayingSong = player.getCurrent() !== null;

    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? getMostPopularVoiceChannel(interaction.guild!);

    const settings = await getGuildSettings(guildId);

    const {playlistLimit, queueAddResponseEphemeral} = settings;

    await interaction.deferReply({flags: queueAddResponseEphemeral ? MessageFlags.Ephemeral : undefined});
    await interaction.editReply('Looking that up...');
    debug(`Queue lookup started: guild=${guildId} query=${query}`);

    let [newSongs, extraMsg] = await this.getSongs.getSongs(query, playlistLimit, shouldSplitChapters);
    debug(`Queue lookup finished: guild=${guildId} songs=${newSongs.length}`);

    if (newSongs.length === 0) {
      throw new Error('No songs found.');
    }

    if (shuffleAdditions) {
      newSongs = shuffle(newSongs);
    }

    if (this.config.ENABLE_SPONSORBLOCK) {
      debug(`SponsorBlock lookup started: guild=${guildId} songs=${newSongs.length}`);
      newSongs = await Promise.all(newSongs.map(this.skipNonMusicSegments.bind(this)));
      debug(`SponsorBlock lookup finished: guild=${guildId} songs=${newSongs.length}`);
    }

    // When inserting at the front one-by-one, each song lands at position 1,
    // pushing the previous to position 2 — so iterate in reverse to preserve order.
    const songsToAdd = addToFrontOfQueue && newSongs.length > 1 ? [...newSongs].reverse() : newSongs;
    songsToAdd.forEach(song => {
      player.add({
        ...song,
        offset: 0,
        addedInChannelId: interaction.channel!.id,
        requestedBy: interaction.member!.user.id,
      }, {immediate: addToFrontOfQueue ?? false});
    });

    const firstSong = newSongs[0];

    let statusMsg = '';

    if (player.voiceConnection === null) {
      await interaction.editReply(`Joining **${targetVoiceChannel.name}**...`);
      debug(`Voice join started: guild=${guildId} channel=${targetVoiceChannel.id}`);
      await player.connect(targetVoiceChannel);
      debug(`Voice join finished: guild=${guildId} channel=${targetVoiceChannel.id}`);

      // Resume / start playback
      await interaction.editReply('Starting playback...');
      debug(`Playback start requested: guild=${guildId} song=${firstSong.url}`);
      await player.play();
      debug(`Playback started: guild=${guildId} song=${firstSong.url}`);

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }

      await interaction.editReply({
        embeds: [buildPlayingMessageEmbed(player)],
      });
    } else if (player.status === STATUS.IDLE) {
      // Player is idle, start playback instead
      await player.play();
    }

    if (skipCurrentTrack) {
      try {
        await player.forward(1);
      } catch (_: unknown) {
        throw new Error('No song to skip to.');
      }
    }

    // Build response message
    if (statusMsg !== '') {
      if (extraMsg === '') {
        extraMsg = statusMsg;
      } else {
        extraMsg = `${statusMsg}, ${extraMsg}`;
      }
    }

    if (extraMsg !== '') {
      extraMsg = ` (${extraMsg})`;
    }

    if (newSongs.length === 1) {
      await interaction.editReply(`Added **${getSongTitle(firstSong)}** to the${addToFrontOfQueue ? ' front of the' : ''} queue${skipCurrentTrack ? ' and skipped the current track' : ''}${extraMsg}.`);
    } else {
      await interaction.editReply(`Added **${getSongTitle(firstSong)}** and ${newSongs.length - 1} other songs to the queue${skipCurrentTrack ? ' and skipped the current track' : ''}${extraMsg}.`);
    }
  }

  private async skipNonMusicSegments(song: SongMetadata) {
    if (!this.sponsorBlock
          || (this.sponsorBlockDisabledUntil && new Date() < this.sponsorBlockDisabledUntil)
          || song.source !== MediaSource.Youtube
          || !song.url) {
      return song;
    }

    try {
      const segments = await this.cache.wrap(
        async () => this.sponsorBlock?.getSegments(song.url, ['music_offtopic']),
        {
          key: song.url, // Value is too short for hashing
          expiresIn: ONE_HOUR_IN_SECONDS,
        },
      ) ?? [];
      const skipSegments = segments
        .sort((a, b) => a.startTime - b.startTime)
        .reduce((acc: Array<{startTime: number; endTime: number}>, {startTime, endTime}) => {
          const previousSegment = acc[acc.length - 1];
          // If segments overlap merge
          if (previousSegment && previousSegment.endTime > startTime) {
            acc[acc.length - 1].endTime = endTime;
          } else {
            acc.push({startTime, endTime});
          }

          return acc;
        }, []);

      const intro = skipSegments[0];
      const outro = skipSegments.at(-1);
      if (outro && outro?.endTime >= song.length - 2) {
        song.length -= outro.endTime - outro.startTime;
      }

      if (intro?.startTime <= 2) {
        song.offset = Math.floor(intro.endTime);
        song.length -= song.offset;
      }

      return song;
    } catch (e) {
      if (!(e instanceof Error)) {
        console.error('Unexpected event occurred while fetching skip segments : ', e);
        return song;
      }

      if (!e.message.includes('404')) {
        // Don't log 404 response, it just means that there are no segments for given video
        console.warn(`Could not fetch skip segments for "${song.url}" :`, e);
      }

      if (e.message.includes('504')) {
        // Stop fetching SponsorBlock data when servers are down
        this.sponsorBlockDisabledUntil = new Date(new Date().getTime() + (this.sponsorBlockTimeoutDelay * 60_000));
      }

      return song;
    }
  }
}
