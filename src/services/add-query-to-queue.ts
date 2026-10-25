import {ChatInputCommandInteraction, GuildMember, MessageFlags, PermissionFlagsBits, PermissionsBitField} from 'discord.js';
import {inject, injectable} from 'inversify';
import shuffle from 'array-shuffle';
import uniqueSongs from '../utils/unique-songs.js';
import {TYPES} from '../types.js';
import GetSongs from '../services/get-songs.js';
import Player, {MediaSource, type PlayingMessageTerminalState, SongMetadata, STATUS} from './player.js';
import PlayerManager from '../managers/player.js';
import {buildQueueEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {SponsorBlock} from 'sponsorblock-api';
import Config from './config.js';
import KeyValueCacheProvider from './key-value-cache.js';
import {MUSIC_CONTROL_EMOJIS, ONE_HOUR_IN_SECONDS} from '../utils/constants.js';
import debug from '../utils/debug.js';
import {getSongTitle} from '../utils/song-title.js';
import formatSongReply from '../utils/format-song-reply.js';

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

    const {playlistLimit, defaultQueuePageSize = 10} = settings;

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
      newSongs = shuffle(uniqueSongs(newSongs));
    }

    if (this.config.ENABLE_SPONSORBLOCK) {
      debug(`SponsorBlock lookup started: guild=${guildId} songs=${newSongs.length}`);
      newSongs = await Promise.all(newSongs.map(this.skipNonMusicSegments.bind(this)));
      debug(`SponsorBlock lookup finished: guild=${guildId} songs=${newSongs.length}`);
    }

    const needsConnection = player.voiceConnection === null;
    if (needsConnection) {
      // A failed join must not leave an unacknowledged request in the queue.
      await interaction.editReply(`Joining **${targetVoiceChannel.name}**...`);
      debug(`Voice join started: guild=${guildId} channel=${targetVoiceChannel.id}`);
      await player.connect(targetVoiceChannel);
      debug(`Voice join finished: guild=${guildId} channel=${targetVoiceChannel.id}`);
    } else {
      // Let an existing session recover without changing its channel or paused state.
      await player.ensureVoiceConnectionReady();
    }

    newSongs.forEach((song, index) => {
      player.add({
        ...song,
        addedInChannelId: interaction.channel!.id,
        requestedBy: interaction.member!.user.id,
      }, {
        immediate: addToFrontOfQueue,
        immediateOffset: index,
      });
    });

    const firstSong = newSongs[0];

    let statusMsg = '';
    let shouldShowPlayingEmbed = false;

    if (needsConnection) {
      // Resume / start playback
      await interaction.editReply('Starting playback...');
      debug(`Playback start requested: guild=${guildId} song=${firstSong.url}`);
      await player.play();
      debug(`Playback started: guild=${guildId} song=${firstSong.url}`);

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }

      shouldShowPlayingEmbed = true;
    } else if (player.status === STATUS.IDLE) {
      // Player is idle, start playback instead
      await player.play();
      shouldShowPlayingEmbed = true;
    }

    if (!player.getCurrent()) {
      throw new Error('no playable songs found');
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

    extraMsg = [statusMsg, extraMsg].filter(Boolean).join(', ');
    if (extraMsg !== '') {
      extraMsg = ` (${extraMsg})`;
    }

    const responseContent = newSongs.length === 1
      ? formatSongReply(getSongTitle(firstSong), 'Added **', `** to the${addToFrontOfQueue ? ' front of the' : ''} queue${didSkipCurrentTrack ? ' and skipped the current track' : ''}${extraMsg}.`)
      : formatSongReply(getSongTitle(firstSong), 'Added **', `** and ${newSongs.length - 1} other songs to the queue${didSkipCurrentTrack ? ' and skipped the current track' : ''}${extraMsg}.`);

    if (!shouldShowPlayingEmbed) {
      await interaction.editReply(responseContent);
      return;
    }

    await this.sendPlayingMessage({
      interaction,
      player,
      content: responseContent,
      pageSize: defaultQueuePageSize,
      ephemeral: false,
    });
  }

  /** Attach a single live response to the session, using the appropriate Discord edit API. */
  private async sendPlayingMessage({interaction, player, content, pageSize, ephemeral}: {
    interaction: ChatInputCommandInteraction;
    player: Player;
    content: string;
    pageSize: number;
    ephemeral: boolean;
  }): Promise<void> {
    const guildId = interaction.guild!.id;
    // The queue embed supplies both the progress timer and the upcoming list
    // for the live response associated with this playback session.
    const responsePromise = interaction.editReply({
      content,
      embeds: [buildQueueEmbed(player, 1, pageSize)],
    });
    let finishControls!: () => void;
    const controlsFinished = new Promise<void>(resolve => {
      finishControls = resolve;
    });
    const updatePlayingMessage = async (terminalState?: PlayingMessageTerminalState) => {
      // Capture before yielding: stop() can clear the queue while Discord is pending.
      const update = terminalState === 'stopped'
        ? {content: 'Playback stopped.', embeds: []}
        : terminalState === 'finished'
          ? {content, embeds: []}
          : {embeds: [buildQueueEmbed(player, 1, pageSize)]};
      const response = await responsePromise;

      // Public interaction responses become regular channel messages and can
      // use Message.edit. Ephemeral responses must remain on the interaction webhook.
      try {
        if (ephemeral) {
          await interaction.editReply(update);
        } else {
          await response.edit(update);
        }
      } finally {
        if (terminalState && !ephemeral) {
          // Wait for any pending addition, without delaying the terminal text.
          // Clear controls even if Discord rejected the final message edit.
          await controlsFinished;
          await response.reactions.removeAll().catch(error => {
            console.warn(`Could not remove music controls for guild ${guildId}:`, error);
          });
        }
      }
    };

    // Register before Discord publishes the response so stop/finish cannot be lost.
    player.setPlayingMessageUpdater(updatePlayingMessage);

    try {
      const response = await responsePromise;
      if (ephemeral || !player.setPlayingMessageId(updatePlayingMessage, response.id)) {
        return;
      }

      // Add controls sequentially so Discord displays them in transport order.
      for (const emoji of MUSIC_CONTROL_EMOJIS) {
        if (!player.isPlayingMessage(response.id)) {
          break;
        }

        try {
          // Reaction order is part of the transport-control layout.
          // eslint-disable-next-line no-await-in-loop
          await response.react(emoji);
        } catch (error: unknown) {
          console.warn(`Could not add music control ${emoji} for guild ${guildId}:`, error);
        }
      }
    } finally {
      finishControls();
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
      const originalStart = song.offset;
      const originalEnd = song.offset + song.length;
      const skipSegments = segments
        .filter(({startTime, endTime}) => endTime > originalStart && startTime < originalEnd)
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
      // SponsorBlock timestamps refer to the full source, including when this
      // queue entry is only a chapter. Clamp both trims to that entry's interval.
      const start = intro && intro.startTime <= originalStart + 2
        ? Math.min(originalEnd, Math.max(originalStart, Math.floor(intro.endTime)))
        : originalStart;
      const end = outro && outro.endTime >= originalEnd - 2
        ? Math.max(start, Math.min(originalEnd, outro.startTime))
        : originalEnd;
      song.offset = start;
      song.length = Math.max(0, end - start);

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
