import {ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
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

const isSameQueueEntry = (capturedId: number | null, currentId: number | null) => (
  capturedId !== null && capturedId === currentId
);

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
    const currentQueueEntryId = player.getCurrentQueueEntryId();
    const wasPlayingSong = currentQueueEntryId !== null;

    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? getMostPopularVoiceChannel(interaction.guild!);

    const settings = await getGuildSettings(guildId);

    const {playlistLimit} = settings;

    await interaction.deferReply();
    await interaction.editReply('Looking that up...');
    debug(`Queue lookup started: guild=${guildId} query=${query}`);

    // Support comma-delimited multi-query input for privileged users or when alone in VC
    let newSongs: SongMetadata[] = [];
    let extraMsg = '';

    const commaSeparated = query.split(',').map(s => s.trim()).filter(Boolean);
    if (commaSeparated.length > 1) {
      // Permission check: allow only instance owner, ManageGuild, or alone in VC
      const userId = interaction.user.id;
      const isInstanceOwner = userId === '221701506561212416' || (this.config.INSTANCE_OWNER_ID !== '' && userId === this.config.INSTANCE_OWNER_ID);
      const hasManageGuild = (interaction.member?.permissions as PermissionsBitField | undefined)?.has(PermissionFlagsBits.ManageGuild) ?? false;

      const voiceChannel = (interaction.member as GuildMember).voice.channel;
      const nonBotMembers = voiceChannel && 'members' in voiceChannel
        ? voiceChannel.members.filter((m: GuildMember) => !m.user.bot)
        : null;
      const isAloneInVC = nonBotMembers !== null && nonBotMembers.size === 1 && nonBotMembers.has(userId);

      if (!(isInstanceOwner || hasManageGuild || isAloneInVC)) {
        try {
          await interaction.followUp({
            content: 'You can only add multiple comma-separated queries if you are the instance owner, have Manage Server permission, or are alone in the voice channel.',
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // ignore follow up errors
        }

        return;
      }

      // Process each comma-separated query sequentially
      for (const part of commaSeparated) {
        const [songsForPart, partExtra] = await this.getSongs.getSongs(part, playlistLimit, shouldSplitChapters);
        debug(`Queue lookup finished for part: guild=${guildId} part=${part} songs=${songsForPart.length}`);
        if (songsForPart.length === 0) {
          // Skip empty results rather than failing the whole request
          continue;
        }

        newSongs.push(...songsForPart);
        if (partExtra && partExtra.length > 0) {
          extraMsg = extraMsg ? `${extraMsg}; ${partExtra}` : partExtra;
        }
      }
    } else {
      const result = await this.getSongs.getSongs(query, playlistLimit, shouldSplitChapters);
      newSongs = result[0];
      extraMsg = result[1];
      debug(`Queue lookup finished: guild=${guildId} songs=${newSongs.length}`);
    }

    const MAX_BATCH_ADD = 25;

    if (newSongs.length === 0) {
      throw new Error('No songs found.');
    }

    // Enforce maximum total additions to avoid huge bursts
    if (newSongs.length > MAX_BATCH_ADD) {
      debug(`Batch add truncated: requested=${newSongs.length} max=${MAX_BATCH_ADD}`);
      newSongs = newSongs.slice(0, MAX_BATCH_ADD);
      extraMsg = extraMsg ? `${extraMsg}; limited to ${MAX_BATCH_ADD} items` : `limited to ${MAX_BATCH_ADD} items`;
    }

    if (shuffleAdditions) {
      newSongs = shuffle(newSongs);
    }

    if (this.config.ENABLE_SPONSORBLOCK) {
      debug(`SponsorBlock lookup started: guild=${guildId} songs=${newSongs.length}`);
      newSongs = await Promise.all(newSongs.map(this.skipNonMusicSegments.bind(this)));
      debug(`SponsorBlock lookup finished: guild=${guildId} songs=${newSongs.length}`);
    }

    // Prepare song objects but don't add to the player's queue until we've
    // successfully joined the voice channel - if join fails we must not add them.
    const preparedSongs = newSongs.map(song => ({
      ...song,
      addedInChannelId: interaction.channel!.id,
      requestedBy: interaction.member!.user.id,
    }));

    const firstSong = newSongs[0];

    let statusMsg = '';
    let shouldShowPlayingEmbed = false;

    if (player.voiceConnection === null) {
      await interaction.editReply(`Joining **${targetVoiceChannel.name}**...`);
      debug(`Voice join started: guild=${guildId} channel=${targetVoiceChannel.id}`);
      await player.connect(targetVoiceChannel);
      debug(`Voice join finished: guild=${guildId} channel=${targetVoiceChannel.id}`);

      // Add songs only after successful connect
      preparedSongs.forEach((song, index) => {
        player.add(song, {immediate: addToFrontOfQueue ?? false, immediateOffset: index});
      });

      // Resume / start playback
      await interaction.editReply('Starting playback...');
      debug(`Playback start requested: guild=${guildId} song=${firstSong.url}`);
      await player.play();
      debug(`Playback started: guild=${guildId} song=${firstSong.url}`);

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }

      shouldShowPlayingEmbed = true;
    } else {
      // Already connected - add songs now.
      preparedSongs.forEach((song, index) => {
        player.add(song, {immediate: addToFrontOfQueue ?? false, immediateOffset: index});
      });

      if (player.status === STATUS.IDLE) {
        // Player is idle, start playback instead
        await player.play();
      }
    }

    if (!player.getCurrent()) {
      throw new Error('no playable songs found');
    }

    if (shouldShowPlayingEmbed) {
      await interaction.editReply({
        embeds: [buildPlayingMessageEmbed(player)],
      });
    }

    let didSkipCurrentTrack = false;
    if (skipCurrentTrack && isSameQueueEntry(currentQueueEntryId, player.getCurrentQueueEntryId())) {
      try {
        await player.forward(1);
        didSkipCurrentTrack = true;
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
      await interaction.editReply(`Added **${getSongTitle(firstSong)}** to the${addToFrontOfQueue ? ' front of the' : ''} queue${didSkipCurrentTrack ? ' and skipped the current track' : ''}${extraMsg}.`);
    } else {
      await interaction.editReply(`Added **${getSongTitle(firstSong)}** and ${newSongs.length - 1} other songs to the queue${didSkipCurrentTrack ? ' and skipped the current track' : ''}${extraMsg}.`);
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
            acc[acc.length - 1].endTime = Math.max(previousSegment.endTime, endTime);
          } else {
            acc.push({startTime, endTime});
          }

          return acc;
        }, []);

      const intro = skipSegments[0];
      const outro = skipSegments.at(-1);
      const shouldTrimIntro = intro && intro.startTime <= 2;
      const shouldTrimOutro = outro && outro.endTime >= song.length - 2;
      if (shouldTrimOutro && (!shouldTrimIntro || outro !== intro)) {
        song.length -= Math.max(0, outro.endTime - outro.startTime);
      }

      if (shouldTrimIntro) {
        song.offset = Math.max(0, Math.floor(intro.endTime));
        song.length -= song.offset;
      }

      song.length = Math.max(0, song.length);

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
