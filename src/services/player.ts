import {PermissionsBitField, VoiceChannel} from 'discord.js';
import {Readable} from 'stream';
import {setTimeout as sleep} from 'timers/promises';
import {hashSync as hasha} from 'hasha';
import {WriteStream} from 'fs-capacitor';
import ffmpeg from 'fluent-ffmpeg';
import shuffle from 'array-shuffle';
import {
  AudioPlayer,
  AudioPlayerState,
  AudioPlayerStatus, AudioResource,
  createAudioPlayer,
  createAudioResource, DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import FileCacheProvider from './file-cache.js';
import {PlaybackAttemptTracker, type PlaybackAttemptContext, type PlaybackAttemptToken} from './playback-attempt.js';
import {
  DEFAULT_VOLUME,
  MediaSource,
  STATUS,
  type AgeRestrictedFallbackResolver,
  type PlayerEvents,
  type QueuedPlaylist,
  type QueuedSong,
  type SongMetadata,
} from './player-types.js';
import {destroyVoiceConnection, recoverVoiceConnection} from './voice-connection-recovery.js';
import debug from '../utils/debug.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getYouTubeMediaSource, YtDlpMediaUnavailableError} from '../utils/yt-dlp.js';

export {DEFAULT_VOLUME, MediaSource, STATUS};
export type {AgeRestrictedFallbackResolver, PlayerEvents, QueuedPlaylist, QueuedSong, SongMetadata};

type PlayerPlaybackAttemptContext = PlaybackAttemptContext<QueuedSong, VoiceConnection>;

export interface PlayerPublic {
  getPosition(): number;
  getCurrent(): QueuedSong | null;
  status: STATUS;
  loopCurrentSong: boolean;
  loopCurrentQueue: boolean;
  getVolume(): number;
  isVolumeOverridden(): boolean;
  getOverriddenTarget(): number | null;
  getPreDuckingVolume(): number | null;
}

export default class Player implements PlayerPublic {
  public voiceConnection: VoiceConnection | null = null;
  public status = STATUS.PAUSED;
  public guildId: string;
  public loopCurrentSong = false;
  public loopCurrentQueue = false;
  private currentChannel: VoiceChannel | undefined;
  private queue: QueuedSong[] = [];
  private queuePosition = 0;
  private audioPlayer: AudioPlayer | null = null;
  private audioResource: AudioResource | null = null;
  private volume?: number;
  private defaultVolume: number = DEFAULT_VOLUME;
  private nowPlaying: QueuedSong | null = null;
  private currentQueueEntryVersion = 0;
  private nowPlayingQueueEntryVersion: number | null = null;
  private readonly playbackAttempts: PlaybackAttemptTracker<QueuedSong, VoiceConnection>;
  private readonly programmaticallyStoppedAudioPlayers = new WeakSet<AudioPlayer>();
  private playPositionInterval: NodeJS.Timeout | undefined;
  private lastSongURL = '';
  private skipVotes = new Set<string>();
  private unexpectedIdleSongUrl: string | null = null;
  private unexpectedIdleRetries = 0;

  private positionInSeconds = 0;
  private readonly fileCache: FileCacheProvider;
  private readonly ageRestrictedFallbackResolver?: AgeRestrictedFallbackResolver;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private shouldIgnoreNextIdleEvent = false;

  private readonly channelToSpeakingUsers: Map<string, Set<string>> = new Map();
  private volumeBeforeVoiceActivity?: number;
  private voiceActivityVolumeTarget?: number;
  private voiceActivitySessionGeneration = 0;
  private hasRegisteredVoiceActivityListener = false;
  private preDuckingVolume: number | null = null;
  private duckInterval: NodeJS.Timeout | null = null;
  private duckTargetVolume: number | null = null;
  private ducking = false;
  private pauseResourceTimeout: NodeJS.Timeout | null = null;
  public static readonly PAUSE_RESOURCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  // Expose override info via public getters
  public isVolumeOverridden(): boolean {
    return this.preDuckingVolume !== null && this.duckTargetVolume !== null;
  }

  public getOverriddenTarget(): number | null {
    return this.duckTargetVolume;
  }

  public getPreDuckingVolume(): number | null {
    return this.preDuckingVolume;
  }
  private speakingSampleInProgress: Set<string> = new Set();
  private speakingEma: Map<string, number> = new Map();
  private speakingEndTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(fileCache: FileCacheProvider, guildId: string, ageRestrictedFallbackResolver?: AgeRestrictedFallbackResolver) {
    this.fileCache = fileCache;
    this.guildId = guildId;
    this.ageRestrictedFallbackResolver = ageRestrictedFallbackResolver;
    this.playbackAttempts = new PlaybackAttemptTracker(() => ({
      currentSong: this.getCurrent(),
      queueEntryVersion: this.getCurrentQueueEntryId(),
      currentConnection: this.voiceConnection,
    }));
  }

  async connect(channel: VoiceChannel): Promise<void> {
    if (this.voiceConnection) {
      this.disconnect();
    }

    // Always get freshest default volume setting value
    const settings = await getGuildSettings(this.guildId);
    const {defaultVolume = DEFAULT_VOLUME} = settings;
    this.defaultVolume = defaultVolume;

    const botMember = channel.guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    const canView = permissions?.has(PermissionsBitField.Flags.ViewChannel) ?? false;
    const canConnect = permissions?.has(PermissionsBitField.Flags.Connect) ?? false;
    const canSpeak = permissions?.has(PermissionsBitField.Flags.Speak) ?? false;
    const canUseVAD = permissions?.has(PermissionsBitField.Flags.UseVAD) ?? false;
    debug(`Voice permissions: guild=${channel.guild.id} channel=${channel.id} view=${String(canView)} connect=${String(canConnect)} speak=${String(canSpeak)} useVAD=${String(canUseVAD)}`);

    if (!canView || !canConnect || !canSpeak) {
      throw new Error(`I need View Channel, Connect, and Speak permissions for "${channel.name}" before I can join.`);
    }

    const voiceConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      selfDeaf: false,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    });

    this.voiceConnection = voiceConnection;
    this.currentChannel = channel;
    this.hasRegisteredVoiceActivityListener = false;

    voiceConnection.on('error', error => {
      console.error(`Voice connection error for guild ${this.guildId}:`, error);
    });

    const guildSettings = await getGuildSettings(this.guildId);
    const stateTransitions = [voiceConnection.state.status];
    voiceConnection.on('stateChange', (oldState, newState) => {
      stateTransitions.push(newState.status);
      if (stateTransitions.length > 10) {
        stateTransitions.shift();
      }

      debug(`Voice connection state changed: ${oldState.status} -> ${newState.status}`);

      if (this.voiceConnection === voiceConnection
        && newState.status === VoiceConnectionStatus.Ready
        && !this.hasRegisteredVoiceActivityListener) {
        this.registerVoiceActivityListener(guildSettings);
        this.hasRegisteredVoiceActivityListener = true;
      }
    });

    voiceConnection.on(
      VoiceConnectionStatus.Disconnected,
      this.onVoiceConnectionDisconnect.bind(this, voiceConnection),
    );

    try {
      await this.waitForVoiceConnectionReady(voiceConnection);
    } catch {
      const {status} = voiceConnection.state;
      destroyVoiceConnection(voiceConnection);

      if (this.voiceConnection === voiceConnection) {
        this.voiceConnection = null;
      }

      throw new Error(`Failed to connect to the voice channel (last state: ${status}, rejoin attempts: ${voiceConnection.rejoinAttempts}, recent states: ${stateTransitions.join(' -> ')}).`);
    }
  }

  disconnect(): void {
    this.playbackAttempts.invalidate();
    this.voiceActivitySessionGeneration++;

    if (this.voiceConnection) {
      if (this.status === STATUS.PLAYING) {
        this.pause();
      }

      this.loopCurrentSong = false;
      destroyVoiceConnection(this.voiceConnection);
      this.stopAudioPlayer(true);

      this.voiceConnection = null;
      this.audioPlayer = null;
      this.audioResource = null;
      this.currentChannel = undefined;
      this.channelToSpeakingUsers.clear();
      this.volumeBeforeVoiceActivity = undefined;
      this.voiceActivityVolumeTarget = undefined;
      this.hasRegisteredVoiceActivityListener = false;

      // Reset any in-progress ducking so the next session starts from the user's volume.
      if (this.duckInterval) {
        clearInterval(this.duckInterval);
        this.duckInterval = null;
      }

      for (const timeout of this.speakingEndTimeouts.values()) {
        clearTimeout(timeout);
      }

      this.speakingEndTimeouts.clear();

      if (this.preDuckingVolume !== null) {
        this.volume = this.preDuckingVolume;
        this.preDuckingVolume = null;
      }

      this.duckTargetVolume = null;
      this.ducking = false;
    }
  }

  async seek(positionSeconds: number): Promise<void> {
    const attempt = this.playbackAttempts.begin();
    await this.seekWithAttempt(positionSeconds, attempt);
  }

  async forwardSeek(positionSeconds: number): Promise<void> {
    return this.seek(this.positionInSeconds + positionSeconds);
  }

  getPosition(): number {
    return this.positionInSeconds;
  }

  async play(allowAgeRestrictedFallback = true): Promise<void> {
    const attempt = this.playbackAttempts.begin();
    await this.playWithAttempt(attempt, allowAgeRestrictedFallback);
  }

  pause(): void {
    if (this.status !== STATUS.PLAYING) {
      throw new Error('Not currently playing.');
    }

    this.playbackAttempts.invalidate();
    this.status = STATUS.PAUSED;

    if (this.audioPlayer) {
      this.audioPlayer.pause();
      // Stop any in-progress duck/ramp so it doesn't continue while paused.
      if (this.duckInterval) {
        clearInterval(this.duckInterval);
        this.duckInterval = null;
      }
      // Re-apply the current volume on the resource to ensure state is consistent.
      this.setAudioPlayerVolume();
      // Schedule tearing down the ffmpeg/resource after TTL to avoid leaking while paused.
      if (this.pauseResourceTimeout) {
        clearTimeout(this.pauseResourceTimeout);
      }
      this.pauseResourceTimeout = setTimeout(() => {
        if (this.status === STATUS.PAUSED) {
          debug('pause: tearing down audio resource after TTL');
          try {
            this.audioPlayer?.stop(true);
          } catch (e) {
            // ignore
          }
          this.audioPlayer = null;
          this.audioResource = null;
        }
        this.pauseResourceTimeout = null;
      }, Player.PAUSE_RESOURCE_TTL_MS);
    }

    this.stopTrackingPosition();
  }

  async forward(skip: number): Promise<void> {
    // Adjust queue position correctly to skip the exact number of songs
    if (skip < 1) {
      throw new Error('Invalid number of songs to skip.');
    }

    const originalQueuePosition = this.queuePosition;
    const originalQueueEntryVersion = this.currentQueueEntryVersion;
    this.manualForward(skip);
    const destinationSong = this.getCurrent();
    const destinationQueueEntryVersion = this.currentQueueEntryVersion;
    let destinationPlayback: PlayerPlaybackAttemptContext | null = null;

    try {
      if (!destinationSong) {
        await this.finishQueue();
      } else if (this.status !== STATUS.PAUSED) {
        const playPromise = this.play();
        const destinationConnection = this.voiceConnection;
        if (destinationConnection && destinationSong && destinationQueueEntryVersion !== null) {
          destinationPlayback = this.playbackAttempts.capture(
            this.playbackAttempts.latest(),
            destinationSong,
            destinationQueueEntryVersion,
            destinationConnection,
          );
        }

        await playPromise;
      }
    } catch (error: unknown) {
      const failedTransitionStillOwnsDestination = this.getCurrent() === destinationSong
        && this.currentQueueEntryVersion === destinationQueueEntryVersion
        && (destinationPlayback === null || this.playbackAttempts.owns(destinationPlayback));
      if (failedTransitionStillOwnsDestination) {
        this.queuePosition = originalQueuePosition;
        this.currentQueueEntryVersion = originalQueueEntryVersion;
      }

      throw error;
    }
  }

  registerVoiceActivityListener(guildSettings: Awaited<ReturnType<typeof getGuildSettings>>) {
    const {volumeDucking, volumeDuckingTarget} = guildSettings;
    const {voiceConnection, currentChannel} = this;
    if (!volumeDucking || !voiceConnection || !currentChannel) {
      return;
    }

    const voiceActivitySessionGeneration = ++this.voiceActivitySessionGeneration;
    const isCurrentVoiceActivitySession = () => (
      voiceActivitySessionGeneration === this.voiceActivitySessionGeneration
      && voiceConnection === this.voiceConnection
      && currentChannel === this.currentChannel
    );

    voiceConnection.receiver.speaking.on('start', (userId: string) => {
      if (!isCurrentVoiceActivitySession() || !this.currentChannel) {
        return;
      }

      // If a restore timer was pending for this user, cancel it (they resumed)
      const pendingEnd = this.speakingEndTimeouts.get(userId);
      if (pendingEnd) {
        clearTimeout(pendingEnd);
        this.speakingEndTimeouts.delete(userId);
      }

      const member = this.currentChannel.members.get(userId);
      const channelId = this.currentChannel.id;

      const markAsSpeaking = () => {
        if (!member) return;
        // cancel pending end just in case
        const p = this.speakingEndTimeouts.get(userId);
        if (p) { clearTimeout(p); this.speakingEndTimeouts.delete(userId); }
        if (!this.channelToSpeakingUsers.has(channelId)) this.channelToSpeakingUsers.set(channelId, new Set());
        this.channelToSpeakingUsers.get(channelId)?.add(member.id);
        this.suppressVoiceWhenPeopleAreSpeaking(volumeDuckingTarget);
      };

      // Only consider real (non-bot) users for ducking
      if (!member || member.user?.bot) return;

      // Fast-path: use Discord speaking flag to mark as speaking immediately
      // Only mark speaking when playback is active; ignore when paused/not playing.
      debug('speaking start', {guild: this.guildId, channel: this.currentChannel?.id, userId, status: this.status});
      if (this.status === STATUS.PLAYING) {
        markAsSpeaking();
      }
    });

    voiceConnection.receiver.speaking.on('end', (userId: string) => {
      if (!isCurrentVoiceActivitySession() || !this.currentChannel) {
        return;
      }

      // Cancel any sample-in-progress for this user
      if (this.speakingSampleInProgress.has(userId)) this.speakingSampleInProgress.delete(userId);

      const channelId = this.currentChannel.id;

      // Clear any existing end timeout and schedule a new 500ms delayed removal.
      const existing = this.speakingEndTimeouts.get(userId);
      if (existing) { clearTimeout(existing); this.speakingEndTimeouts.delete(userId); }

      debug('speaking end scheduled', {guild: this.guildId, channel: this.currentChannel?.id, userId, status: this.status});
      // Only schedule end handling if playback is active. If paused, skip scheduling.
      if (this.status !== STATUS.PLAYING) return;
      const t = setTimeout(() => {
        this.speakingEndTimeouts.delete(userId);
        if (!isCurrentVoiceActivitySession() || !this.currentChannel) return;
        // Remove by user id even if the member already left the channel, so
        // a speaker leaving mid-speech still releases the duck.
        if (this.channelToSpeakingUsers.has(channelId)) {
          this.channelToSpeakingUsers.get(channelId)?.delete(userId);
          this.suppressVoiceWhenPeopleAreSpeaking(volumeDuckingTarget);
        }
      }, 500);

      this.speakingEndTimeouts.set(userId, t);
    });
  }

  suppressVoiceWhenPeopleAreSpeaking(volumeDuckingTarget: number): void {
    if (!this.currentChannel) {
      return;
    }

    // Only adjust ducking/volume when audio is actively playing. This prevents
    // ducking logic from running during startup/stream setup which can interfere
    // with playback starting.
    if (this.status !== STATUS.PLAYING) {
      debug('suppressVoiceWhenPeopleAreSpeaking: skipping because not playing', {status: this.status});
      return;
    }

    const speakingUsers = this.channelToSpeakingUsers.get(this.currentChannel.id);
    const currentVol = this.volume || this.defaultVolume;
    const isSpeaking = speakingUsers && speakingUsers.size > 0;
    debug('suppressVoiceWhenPeopleAreSpeaking', {guild: this.guildId, channel: this.currentChannel.id, speakingUsers: Array.from(speakingUsers ?? []), currentVol, volumeDuckingTarget, isSpeaking});

    if (isSpeaking) {
      // Compute effective target volume (0-100)
      const requested = Math.round(volumeDuckingTarget);
      const effectiveTarget = Math.max(0, Math.min(100, requested));

      debug('ducking: applying', {currentVol, requestedTarget: volumeDuckingTarget, effectiveTarget});

      // Only duck if target is lower than current volume
      if (effectiveTarget < currentVol) {
        if (this.preDuckingVolume === null) {
          this.preDuckingVolume = currentVol;
        }
        // Track current duck target and mark ducking state
        this.duckTargetVolume = effectiveTarget;
        this.ducking = true;
        // Ramp down quickly for responsiveness
        debug('duck: ramping down', {from: currentVol, to: effectiveTarget});
        void this.rampVolumeTo(effectiveTarget, 180);
      }
    } else if (this.preDuckingVolume !== null) {
      // Restore to volume before ducking started with a smooth ramp
      const restoreTo = this.preDuckingVolume;
      this.preDuckingVolume = null;
      this.duckTargetVolume = null;
      this.ducking = false;
      // Ramp up a bit slower for smoothness
      debug('duck: restoring volume', {restoreTo});
      void this.rampVolumeTo(restoreTo, 600);
    }
  }

  canGoForward(skip: number) {
    return (this.queuePosition + skip - 1) < this.queue.length;
  }

  manualForward(skip: number): void {
    if (this.canGoForward(skip)) {
      this.queuePosition += skip;
      this.currentQueueEntryVersion++;
      this.positionInSeconds = 0;
      this.stopTrackingPosition();
      this.skipVotes = new Set();
    } else {
      throw new Error('No songs in queue to forward to.');
    }
  }

  canGoBack() {
    return this.queuePosition - 1 >= 0;
  }

  async back(): Promise<void> {
    if (this.canGoBack()) {
      this.queuePosition--;
      this.currentQueueEntryVersion++;
      this.positionInSeconds = 0;
      this.stopTrackingPosition();
      this.skipVotes = new Set();

      if (this.status !== STATUS.PAUSED) {
        await this.play();
      }
    } else {
      throw new Error('No songs in queue to go back to.');
    }
  }

  addSkipVote(userId: string): void {
    this.skipVotes.add(userId);
  }

  getSkipVotes(): ReadonlySet<string> {
    return this.skipVotes;
  }

  getCurrent(): QueuedSong | null {
    if (this.queue[this.queuePosition]) {
      return this.queue[this.queuePosition];
    }

    return null;
  }

  getCurrentQueueEntryId(): number | null {
    return this.getCurrent() === null ? null : this.currentQueueEntryVersion;
  }

  /**
   * Returns queue, not including the current song.
   * @returns {QueuedSong[]}
   */
  getQueue(): QueuedSong[] {
    return this.queue.slice(this.queuePosition + 1);
  }

  add(song: QueuedSong, {immediate = false, immediateOffset = 0} = {}): void {
    const currentSong = this.getCurrent();

    if (immediate) {
      // Add as the next song to be played
      const insertAt = this.queuePosition + immediateOffset + 1;
      this.queue = [...this.queue.slice(0, insertAt), song, ...this.queue.slice(insertAt)];
    } else {
      // Add to end of queue
      this.queue.push(song);
    }

    if (this.getCurrent() !== currentSong) {
      this.currentQueueEntryVersion++;
    }
  }

  shuffle(): void {
    const shuffledSongs = shuffle(this.queue.slice(this.queuePosition + 1));

    this.queue = [...this.queue.slice(0, this.queuePosition + 1), ...shuffledSongs];
  }

  clear(): void {
    const newQueue = [];

    // Don't clear curently playing song
    const current = this.getCurrent();

    if (current) {
      newQueue.push(current);
    }

    this.queuePosition = 0;
    this.queue = newQueue;
  }

  removeFromQueue(index: number, amount = 1): void {
    this.queue.splice(this.queuePosition + index, amount);
  }

  removeCurrent(): void {
    this.queue = [...this.queue.slice(0, this.queuePosition), ...this.queue.slice(this.queuePosition + 1)];
    this.currentQueueEntryVersion++;
  }

  queueSize(): number {
    return this.getQueue().length;
  }

  isQueueEmpty(): boolean {
    return this.queueSize() === 0;
  }

  stop(): void {
    this.disconnect();
    this.queuePosition = 0;
    this.queue = [];
    this.currentQueueEntryVersion++;
  }

  move(from: number, to: number): QueuedSong {
    if (from > this.queueSize() || to > this.queueSize()) {
      throw new Error('Move index is outside the range of the queue.');
    }

    this.queue.splice(this.queuePosition + to, 0, this.queue.splice(this.queuePosition + from, 1)[0]);

    return this.queue[this.queuePosition + to];
  }

  setVolume(level: number): void {
    // Level should be a number between 0 and 100 => 0%..100%
    const safe = Number.isFinite(level) ? Math.round(level) : this.defaultVolume;
    const clamped = Math.max(0, Math.min(100, safe));
    this.volume = clamped;
    this.setAudioPlayerVolume(clamped);
  }

  getVolume(): number {
    // Only use default volume if player volume is not already set (in the event of a reconnect we shouldn't reset)
    return this.voiceActivityVolumeTarget ?? this.volume ?? this.defaultVolume;
  }

  private async seekWithAttempt(positionSeconds: number, attempt: PlaybackAttemptToken): Promise<void> {
    this.status = STATUS.PAUSED;

    const currentSong = this.getCurrent();
    const currentQueueEntryVersion = this.getCurrentQueueEntryId();
    const voiceConnection = await this.ensureVoiceConnectionReady();

    if (!this.playbackAttempts.isCurrent(attempt, voiceConnection)) {
      return;
    }

    if (!currentSong) {
      throw new Error('No song currently playing');
    }

    if (currentQueueEntryVersion === null) {
      return;
    }

    const playback = this.playbackAttempts.capture(
      attempt,
      currentSong,
      currentQueueEntryVersion,
      voiceConnection,
    );
    if (!this.playbackAttempts.owns(playback)) {
      return;
    }

    if (positionSeconds > currentSong.length) {
      throw new Error('Seek position is outside the range of the song.');
    }

    let realPositionSeconds = positionSeconds;
    let to: number | undefined;
    if (currentSong.offset !== undefined) {
      realPositionSeconds += currentSong.offset;
      to = currentSong.length + currentSong.offset;
    }

    const stream = await this.getStream(currentSong, {seek: realPositionSeconds, to});
    if (!this.playbackAttempts.owns(playback)) {
      this.destroyStaleStream(stream);
      return;
    }

    this.audioPlayer = createAudioPlayer({
      behaviors: {
        // Needs to be somewhat high for livestreams
        maxMissedFrames: 50,
      },
    });
    voiceConnection.subscribe(this.audioPlayer);
    this.playAudioPlayerResource(this.createAudioStream(stream));
    this.attachListeners();
    this.startTrackingPosition(positionSeconds);

    this.status = STATUS.PLAYING;
    this.nowPlaying = currentSong;
    this.nowPlayingQueueEntryVersion = currentQueueEntryVersion;
  }

  private async playWithAttempt(attempt: PlaybackAttemptToken, allowAgeRestrictedFallback: boolean): Promise<void> {
    const currentSong = this.getCurrent();
    const currentQueueEntryVersion = this.getCurrentQueueEntryId();
    const voiceConnection = await this.ensureVoiceConnectionReady();

    if (!this.playbackAttempts.isCurrent(attempt, voiceConnection)) {
      return;
    }

    if (!currentSong) {
      throw new Error('Queue empty.');
    }

    if (currentQueueEntryVersion === null) {
      return;
    }

    const playback = this.playbackAttempts.capture(
      attempt,
      currentSong,
      currentQueueEntryVersion,
      voiceConnection,
    );
    if (!this.playbackAttempts.owns(playback)) {
      return;
    }

    // Cancel any pending idle disconnection
    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    // Resume from paused state
    if (this.status === STATUS.PAUSED
      && currentSong === this.nowPlaying
      && this.currentQueueEntryVersion === this.nowPlayingQueueEntryVersion) {
      if (this.audioPlayer) {
        // If the underlying resource is missing or the player is not in a
        // paused state (it may have gone idle while paused), recreate the
        // stream via seek instead of attempting to unpause a dead player.
        if (!this.audioResource || this.audioPlayer.state.status !== AudioPlayerStatus.Paused) {
          return this.seekWithAttempt(this.getPosition(), attempt);
        }

        // Clear any scheduled teardown since we're resuming playback.
        if (this.pauseResourceTimeout) {
          clearTimeout(this.pauseResourceTimeout);
          this.pauseResourceTimeout = null;
        }

        this.audioPlayer.unpause();
        this.status = STATUS.PLAYING;
        // Ensure resource volume/state is reapplied after resume.
        this.setAudioPlayerVolume();
        this.startTrackingPosition();
        return;
      }

      // Was disconnected, need to recreate stream
      if (!currentSong.isLive) {
        return this.seekWithAttempt(this.getPosition(), attempt);
      }
    }

    try {
      let positionSeconds: number | undefined;
      let to: number | undefined;
      if (currentSong.offset !== undefined) {
        positionSeconds = currentSong.offset;
        to = currentSong.length + currentSong.offset;
      }

      const stream = await this.getStream(currentSong, {seek: positionSeconds, to});
      if (!this.playbackAttempts.owns(playback)) {
        this.destroyStaleStream(stream);
        return;
      }

      this.audioPlayer = createAudioPlayer({
        behaviors: {
          // Needs to be somewhat high for livestreams
          maxMissedFrames: 50,
        },
      });
      voiceConnection.subscribe(this.audioPlayer);
      this.playAudioPlayerResource(this.createAudioStream(stream));

      this.attachListeners();

      this.status = STATUS.PLAYING;
      this.nowPlaying = currentSong;
      this.nowPlayingQueueEntryVersion = currentQueueEntryVersion;
      this.startTrackingPosition(0);
    } catch (error: unknown) {
      await this.handlePlaybackError(
        error,
        playback,
        allowAgeRestrictedFallback,
      );
    }
  }

  private async handlePlaybackError(
    error: unknown,
    playback: PlayerPlaybackAttemptContext,
    allowAgeRestrictedFallback: boolean,
  ): Promise<void> {
    if (!this.playbackAttempts.owns(playback)) {
      throw error;
    }

    const isGone = typeof error === 'object'
      && error !== null
      && 'statusCode' in error
      && error.statusCode === 410;

    if (error instanceof YtDlpMediaUnavailableError
      && error.reason === 'age-restricted'
      && allowAgeRestrictedFallback) {
      const fallbackHandled = await this.tryAgeRestrictedAudioFallback(playback);
      if (fallbackHandled) {
        return;
      }

      if (!this.playbackAttempts.owns(playback)) {
        throw error;
      }
    }

    if (error instanceof YtDlpMediaUnavailableError || isGone) {
      const detail = error instanceof Error ? error.message : 'media returned HTTP 410';
      console.warn(`Skipping unplayable YouTube track for guild ${this.guildId}: ${detail}`);
      await this.advancePastUnplayableTrack();
      return;
    }

    throw error;
  }

  /**
   * Smoothly ramp the player volume to `target` over `durationMs` milliseconds.
   * Cancels any in-progress ramp and resolves when finished.
   */
  private rampVolumeTo(target: number, durationMs = 300): Promise<void> {
    if (this.duckInterval) {
      clearInterval(this.duckInterval);
      this.duckInterval = null;
    }

    const start = this.getVolume();
    debug('rampVolumeTo start', {start, target, durationMs});
    const clampedTarget = Math.max(0, Math.min(100, target));

    if (durationMs <= 0 || start === clampedTarget) {
      this.setVolume(clampedTarget);
      return Promise.resolve();
    }

    const stepMs = 40; // smoothness step (ms)
    const steps = Math.max(1, Math.round(durationMs / stepMs));
    let currentStep = 0;

    return new Promise(resolve => {
      this.duckInterval = setInterval(() => {
        currentStep++;
        const progress = Math.min(1, currentStep / steps);
        const next = Math.round((start + (clampedTarget - start) * progress) * 100) / 100;
        // Ensure numeric and clamped
        const safeNext = Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : clampedTarget;
        this.setVolume(safeNext);

        if (progress >= 1) {
          if (this.duckInterval) {
            clearInterval(this.duckInterval);
            this.duckInterval = null;
          }
          // Log final volume and audio resource state for debugging ducking mute issues
          debug('rampVolumeTo: finished', {start, clampedTarget, final: safeNext, audioResourceVolume: this.audioResource?.volume?.volume});
          resolve();
        }
      }, stepMs);
    });
  }

  private getHashForCache(url: string): string {
    return hasha(url, {algorithm: 'md5'});
  }

  private getArbitraryUrlHeaders(url: string): Record<string, string> {
    const headers: Record<string, string> = {};
    
    // Archive.org requires a User-Agent header
    if (url.includes('archive.org')) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    }
    
    return headers;
  }

  private async getStream(song: QueuedSong, options: {seek?: number; to?: number} = {}): Promise<Readable> {
    if (this.status === STATUS.PLAYING) {
      debug('getStream: stopping existing audio player to replace stream', {status: this.status, nowPlaying: this.nowPlaying?.url});
      this.stopAudioPlayer();
    } else if (this.status === STATUS.PAUSED) {
      debug('getStream: stopping existing audio player (paused) to replace stream', {status: this.status, nowPlaying: this.nowPlaying?.url});
      this.stopAudioPlayer(true);
    }

    if (song.source === MediaSource.HLS) {
      return this.createReadStream({url: song.url, cacheKey: song.url});
    }

    if (song.source === MediaSource.Arbitrary) {
      const ffmpegInputOptions: string[] = [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
      ];
      
      // Add headers for archive.org and other servers that require them
      const headers = this.getArbitraryUrlHeaders(song.url);
      const headerOptions = this.buildFfmpegHeaderOptions(headers);
      ffmpegInputOptions.push(...headerOptions);
      
      if (options.seek) {
        ffmpegInputOptions.push('-ss', options.seek.toString());
      }

      if (options.to) {
        ffmpegInputOptions.push('-to', options.to.toString());
      }

      return this.createReadStream({url: song.url, cacheKey: song.url, ffmpegInputOptions});
    }

    let ffmpegInput: string | null;
    const ffmpegInputOptions: string[] = [];
    let shouldCacheVideo = false;

    ffmpegInput = await this.fileCache.getPathFor(this.getHashForCache(song.url));

    if (!ffmpegInput) {
      const mediaSource = await getYouTubeMediaSource(song.url);
      ffmpegInput = mediaSource.url;

      // Don't cache livestreams or long videos
      const MAX_CACHE_LENGTH_SECONDS = 30 * 60; // 30 minutes
      shouldCacheVideo = !mediaSource.isLive && song.length < MAX_CACHE_LENGTH_SECONDS && !options.seek;

      debug(shouldCacheVideo ? 'Caching video' : 'Not caching video');

      ffmpegInputOptions.push(...[
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '5',
      ]);

      const headerOptions = this.buildFfmpegHeaderOptions(mediaSource.headers);
      ffmpegInputOptions.push(...headerOptions);
    }

    if (options.seek) {
      ffmpegInputOptions.push('-ss', options.seek.toString());
    }

    if (options.to) {
      ffmpegInputOptions.push('-to', options.to.toString());
    }

    return this.createReadStream({
      url: ffmpegInput,
      cacheKey: song.url,
      ffmpegInputOptions,
      cache: shouldCacheVideo,
    });
  }

  private startTrackingPosition(initalPosition?: number): void {
    if (initalPosition !== undefined) {
      this.positionInSeconds = initalPosition;
    }

    if (this.playPositionInterval) {
      clearInterval(this.playPositionInterval);
    }

    this.playPositionInterval = setInterval(() => {
      this.positionInSeconds++;
    }, 1000);
  }

  private stopTrackingPosition(): void {
    if (this.playPositionInterval) {
      clearInterval(this.playPositionInterval);
      this.playPositionInterval = undefined;
    }
  }

  private attachListeners(): void {
    if (!this.voiceConnection) {
      return;
    }

    if (!this.audioPlayer) {
      return;
    }

    const {audioPlayer} = this;
    const queueEntryVersion = this.currentQueueEntryVersion;

    debug('attachListeners: binding idle listener', {hasPlayer: !!audioPlayer});

    if (audioPlayer.listeners(AudioPlayerStatus.Idle).length === 0) {
      audioPlayer.on(AudioPlayerStatus.Idle, (oldState, newState) => {
        debug('audioPlayer Idle event fired', {oldStatus: oldState.status, newStatus: newState.status, nowPlaying: this.nowPlaying?.url});
        // Ignore idle events from players that are no longer active.
        if (this.programmaticallyStoppedAudioPlayers.has(audioPlayer)
          || this.audioPlayer !== audioPlayer
          || this.currentQueueEntryVersion !== queueEntryVersion) {
          debug('audioPlayer Idle: ignored because player instance or queue entry changed');
          return;
        }

        void this.onAudioPlayerIdle(oldState, newState).catch(error => {
          console.error(`Audio player idle handler failed for guild ${this.guildId}:`, error);
        });
      });
    }
  }

  private async onVoiceConnectionDisconnect(voiceConnection: VoiceConnection): Promise<void> {
    await recoverVoiceConnection(voiceConnection, {
      isCurrent: candidate => this.voiceConnection === candidate,
      dispose: candidate => {
        if (this.voiceConnection === candidate) {
          this.disconnect();
        } else {
          destroyVoiceConnection(candidate);
        }
      },
    });
  }

  private async ensureVoiceConnectionReady(): Promise<VoiceConnection> {
    if (this.voiceConnection === null) {
      throw new Error('Not connected to a voice channel.');
    }

    await this.waitForVoiceConnectionReady(this.voiceConnection);

    return this.voiceConnection;
  }

  private async waitForVoiceConnectionReady(voiceConnection: VoiceConnection): Promise<void> {
    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 60_000);
  }

  private destroyVoiceConnection(voiceConnection: VoiceConnection): void {
    if (voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      voiceConnection.destroy();
    }
  }

  private async advancePastUnplayableTrack(): Promise<void> {
    this.manualForward(1);

    if (!this.getCurrent()) {
      await this.finishQueue();
      return;
    }

    await this.play();
  }

  private async tryAgeRestrictedAudioFallback(playback: PlayerPlaybackAttemptContext): Promise<boolean> {
    const {song, queueEntryVersion, attempt, connection} = playback;
    if (!this.ageRestrictedFallbackResolver || song.source !== MediaSource.Youtube) {
      return false;
    }

    if (!this.playbackAttempts.owns(playback)) {
      return true;
    }

    let fallback: SongMetadata | null;
    try {
      fallback = await this.ageRestrictedFallbackResolver(song);
    } catch {
      if (!this.playbackAttempts.owns(playback)) {
        return true;
      }

      console.warn(`Audio fallback search failed for age-restricted track in guild ${this.guildId}.`);
      return false;
    }

    if (!this.playbackAttempts.owns(playback)) {
      return true;
    }

    if (!fallback || fallback.source !== MediaSource.Youtube || fallback.url === song.url) {
      return false;
    }

    const {queuePosition} = this;
    const replacement: QueuedSong = {
      ...fallback,
      playlist: song.playlist,
      addedInChannelId: song.addedInChannelId,
      requestedBy: song.requestedBy,
    };
    this.queue[queuePosition] = replacement;
    const replacementPlayback = this.playbackAttempts.capture(
      attempt,
      replacement,
      queueEntryVersion,
      connection,
    );
    console.warn(`Trying audio fallback for age-restricted YouTube track in guild ${this.guildId}: ${song.url} -> ${replacement.url}`);

    try {
      await this.playWithAttempt(attempt, false);
      return true;
    } catch (error: unknown) {
      if (this.playbackAttempts.owns(replacementPlayback)
        && this.queue[queuePosition] === replacement) {
        this.queue[queuePosition] = song;
      }

      throw error;
    }
  }

  private async onAudioPlayerIdle(_oldState: AudioPlayerState, newState: AudioPlayerState): Promise<void> {
    debug('onAudioPlayerIdle: entry', {shouldIgnoreNextIdleEvent: this.shouldIgnoreNextIdleEvent, status: this.status, nowPlaying: this.nowPlaying?.url});

    if (this.shouldIgnoreNextIdleEvent && newState.status === AudioPlayerStatus.Idle) {
      debug('onAudioPlayerIdle: ignoring idle due to transition flag');
      this.shouldIgnoreNextIdleEvent = false;
      return;
    }

    const currentSong = this.getCurrent();

    if (newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING && currentSong && !currentSong.isLive) {
      const remainingSeconds = currentSong.length - this.getPosition();
      const UNEXPECTED_IDLE_REMAINING_THRESHOLD_SECONDS = 5;
      const MAX_UNEXPECTED_IDLE_RECOVERY_RETRIES = 2;

      // Stream providers occasionally drop early; try to recover current song instead of skipping.
      if (remainingSeconds > UNEXPECTED_IDLE_REMAINING_THRESHOLD_SECONDS) {
        if (this.unexpectedIdleSongUrl === currentSong.url) {
          this.unexpectedIdleRetries++;
        } else {
          this.unexpectedIdleSongUrl = currentSong.url;
          this.unexpectedIdleRetries = 1;
        }

        if (this.unexpectedIdleRetries <= MAX_UNEXPECTED_IDLE_RECOVERY_RETRIES) {
          const resumeAt = Math.max(0, this.getPosition() - 1);
          debug(`Unexpected idle for "${currentSong.title}" at ${this.getPosition()}s (${remainingSeconds}s remaining). Recovery attempt ${this.unexpectedIdleRetries}/${MAX_UNEXPECTED_IDLE_RECOVERY_RETRIES}.`);
          await this.seek(resumeAt);
          return;
        }

        debug(`Unexpected idle recovery exhausted for "${currentSong.title}"; advancing queue.`);
      } else {
        this.unexpectedIdleSongUrl = null;
        this.unexpectedIdleRetries = 0;
      }
    }

    // Automatically advance queued song at end
    if (this.loopCurrentSong && newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING) {
      await this.seek(0);
      return;
    }

    // Automatically re-add current song to queue
    if (this.loopCurrentQueue && newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING) {
      const currentSong = this.getCurrent();

      if (currentSong) {
        this.add(currentSong);
      } else {
        throw new Error('No song currently playing.');
      }
    }

    if (newState.status === AudioPlayerStatus.Idle && this.status === STATUS.PLAYING) {
      this.unexpectedIdleSongUrl = null;
      this.unexpectedIdleRetries = 0;
      await this.forward(1);
      // Auto announce the next song if configured to
      const settings = await getGuildSettings(this.guildId);
      const {autoAnnounceNextSong} = settings;
      if (autoAnnounceNextSong && this.currentChannel && this.getCurrent()) {
        await this.currentChannel.send({
          embeds: [buildPlayingMessageEmbed(this)],
        });
      }
    }
  }

  private async finishQueue(): Promise<void> {
    this.playbackAttempts.invalidate();
    this.stopTrackingPosition();
    this.status = STATUS.IDLE;
    this.stopAudioPlayer(true);

    const settings = await getGuildSettings(this.guildId);

    const {secondsToWaitAfterQueueEmpties} = settings;
    if (secondsToWaitAfterQueueEmpties !== 0) {
      this.disconnectTimer = setTimeout(() => {
        // Make sure we are not accidentally playing
        // when disconnecting
        if (this.status === STATUS.IDLE) {
          this.disconnect();
        }
      }, secondsToWaitAfterQueueEmpties * 1000);
    }
  }

  private buildFfmpegHeaderOptions(headers: Record<string, string>) {
    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');

    if (!headerLines) {
      return [];
    }

    return ['-headers', `${headerLines}\r\n`];
  }

  private async createReadStream(options: {url: string; cacheKey: string; ffmpegInputOptions?: string[]; cache?: boolean}): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const capacitor = new WriteStream();

      if (options?.cache) {
        const cacheStream = this.fileCache.createWriteStream(this.getHashForCache(options.cacheKey));
        capacitor.createReadStream().pipe(cacheStream);
      }

      const returnedStream = capacitor.createReadStream();
      let hasReturnedStreamClosed = false;

      const stream = ffmpeg(options.url)
        .inputOptions(options?.ffmpegInputOptions ?? ['-re'])
        .noVideo()
        .audioCodec('libopus')
        .outputFormat('webm')
        .on('error', error => {
          if (!hasReturnedStreamClosed) {
            reject(error);
          }
        })
        .on('start', command => {
          debug(`Spawned ffmpeg with ${command}`);
        });

      stream.pipe(capacitor);

      returnedStream.on('close', () => {
        if (!options.cache) {
          stream.kill('SIGKILL');
        }

        hasReturnedStreamClosed = true;
      });

      resolve(returnedStream);
    });
  }

  private createAudioStream(stream: Readable) {
    return createAudioResource(stream, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true,
    });
  }

  private playAudioPlayerResource(resource: AudioResource) {
    if (this.audioPlayer !== null) {
      // Clear any pause-timeout if we're about to attach a new resource.
      if (this.pauseResourceTimeout) {
        clearTimeout(this.pauseResourceTimeout);
        this.pauseResourceTimeout = null;
      }

      this.audioResource = resource;
      debug('playAudioPlayerResource: new resource', {url: this.nowPlaying?.url, ducking: this.ducking, preDuckingVolume: this.preDuckingVolume, duckTargetVolume: this.duckTargetVolume});
      this.setAudioPlayerVolume();
      debug('playAudioPlayerResource: calling audioPlayer.play', {url: this.nowPlaying?.url, volume: this.getVolume(), audioResourceVolume: this.audioResource?.volume?.volume});
      this.audioPlayer.play(this.audioResource);
    }
  }

  private setAudioPlayerVolume(level?: number) {
    // Audio resource expects a float between 0 and 1 to represent level percentage
    const effective = (level ?? this.getVolume());
    debug('setAudioPlayerVolume', {level, effective});
    try {
      this.audioResource?.volume?.setVolume(effective / 100);
    } catch (err) {
      debug('setAudioPlayerVolume: failed to set volume', {err: (err as Error).message, effective, audioResource: !!this.audioResource});
    }
  }

  private stopAudioPlayer(force = false): void {
    if (!this.audioPlayer) {
      return;
    }

    this.programmaticallyStoppedAudioPlayers.add(this.audioPlayer);
    this.audioPlayer.stop(force);
  }

  private destroyStaleStream(stream: Readable): void {
    if (!stream.destroyed) {
      stream.destroy();
    }
  }
}
