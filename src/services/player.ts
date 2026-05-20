import {PermissionsBitField, VoiceChannel, Snowflake} from 'discord.js';
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
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import FileCacheProvider from './file-cache.js';
import debug from '../utils/debug.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getYouTubeMediaSource} from '../utils/yt-dlp.js';

export enum MediaSource {
  Youtube,
  HLS,
  Arbitrary,
}

export interface QueuedPlaylist {
  title: string;
  source: string;
}

export interface SongMetadata {
  title: string;
  artist: string;
  url: string; // For YT, it's the video ID (not the full URI)
  length: number;
  offset: number;
  playlist: QueuedPlaylist | null;
  isLive: boolean;
  thumbnailUrl: string | null;
  source: MediaSource;
}
export interface QueuedSong extends SongMetadata {
  addedInChannelId: Snowflake;
  requestedBy: string;
}

export enum STATUS {
  PLAYING,
  PAUSED,
  IDLE,
}

export interface PlayerEvents {
  statusChange: (oldStatus: STATUS, newStatus: STATUS) => void;
}

export const DEFAULT_VOLUME = 50;

export default class {
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
  private playPositionInterval: NodeJS.Timeout | undefined;
  private lastSongURL = '';
  private skipVotes = new Set<string>();
  private unexpectedIdleSongUrl: string | null = null;
  private unexpectedIdleRetries = 0;

  private positionInSeconds = 0;
  private readonly fileCache: FileCacheProvider;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private shouldIgnoreNextIdleEvent = false;

  private readonly channelToSpeakingUsers: Map<string, Set<string>> = new Map();
  private hasRegisteredVoiceActivityListener = false;
  private preDuckingVolume: number | null = null;

  constructor(fileCache: FileCacheProvider, guildId: string) {
    this.fileCache = fileCache;
    this.guildId = guildId;
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

    const guildSettings = await getGuildSettings(this.guildId);
    const stateTransitions = [voiceConnection.state.status];
    voiceConnection.on('stateChange', (oldState, newState) => {
      stateTransitions.push(newState.status);
      if (stateTransitions.length > 10) {
        stateTransitions.shift();
      }

      debug(`Voice connection state changed: ${oldState.status} -> ${newState.status}`);

      if (newState.status === VoiceConnectionStatus.Ready && !this.hasRegisteredVoiceActivityListener) {
        this.registerVoiceActivityListener(guildSettings);
        this.hasRegisteredVoiceActivityListener = true;
      }
    });

    voiceConnection.on('error', error => {
      debug(`Voice connection error: ${error.message}`);
    });

    voiceConnection.on(VoiceConnectionStatus.Disconnected, this.onVoiceConnectionDisconnect.bind(this));

    try {
      await this.waitForVoiceConnectionReady(voiceConnection);
    } catch {
      const {status} = voiceConnection.state;
      this.destroyVoiceConnection(voiceConnection);
      this.voiceConnection = null;
      throw new Error(`Failed to connect to the voice channel (last state: ${status}, rejoin attempts: ${voiceConnection.rejoinAttempts}, recent states: ${stateTransitions.join(' -> ')}).`);
    }
  }

  disconnect(): void {
    if (this.voiceConnection) {
      if (this.status === STATUS.PLAYING) {
        this.pause();
      }

      this.loopCurrentSong = false;
      this.destroyVoiceConnection(this.voiceConnection);
      this.audioPlayer?.stop(true);

      this.voiceConnection = null;
      this.audioPlayer = null;
      this.audioResource = null;
      this.currentChannel = undefined;
      this.channelToSpeakingUsers.clear();
      this.hasRegisteredVoiceActivityListener = false;
    }
  }

  async seek(positionSeconds: number): Promise<void> {
    this.status = STATUS.PAUSED;

    const voiceConnection = await this.ensureVoiceConnectionReady();

    const currentSong = this.getCurrent();

    if (!currentSong) {
      throw new Error('No song currently playing');
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
  }

  async forwardSeek(positionSeconds: number): Promise<void> {
    return this.seek(this.positionInSeconds + positionSeconds);
  }

  getPosition(): number {
    return this.positionInSeconds;
  }

  async play(): Promise<void> {
    const voiceConnection = await this.ensureVoiceConnectionReady();

    const currentSong = this.getCurrent();

    if (!currentSong) {
      throw new Error('Queue empty.');
    }

    // Cancel any pending idle disconnection
    if (this.disconnectTimer) {
      clearInterval(this.disconnectTimer);
      this.disconnectTimer = null;
    }

    // Resume from paused state
    if (this.status === STATUS.PAUSED && currentSong.url === this.nowPlaying?.url) {
      if (this.audioPlayer) {
        this.audioPlayer.unpause();
        this.status = STATUS.PLAYING;
        this.startTrackingPosition();
        return;
      }

      // Was disconnected, need to recreate stream
      if (!currentSong.isLive) {
        return this.seek(this.getPosition());
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

      // We've successfully started playback for the requested song; clear transient ignore flag
      if (this.shouldIgnoreNextIdleEvent) {
        debug('play(): clearing shouldIgnoreNextIdleEvent after successful start', {url: currentSong.url});
        this.shouldIgnoreNextIdleEvent = false;
      }

      if (currentSong.url === this.lastSongURL) {
        this.startTrackingPosition();
      } else {
        // Reset position counter
        this.startTrackingPosition(0);
        this.lastSongURL = currentSong.url;
      }
    } catch (error: unknown) {
      await this.forward(1);

      if ((error as {statusCode: number}).statusCode === 410 && currentSong) {
        const channelId = currentSong.addedInChannelId;

        if (channelId) {
          debug(`${currentSong.title} is unavailable`);
          return;
        }
      }

      throw error;
    }
  }

  pause(): void {
    if (this.status !== STATUS.PLAYING) {
      throw new Error('Not currently playing.');
    }

    this.status = STATUS.PAUSED;

    if (this.audioPlayer) {
      this.audioPlayer.pause();
    }

    this.stopTrackingPosition();
  }

  async forward(skip: number): Promise<void> {
    // Adjust queue position correctly to skip the exact number of songs
    if (skip < 1) {
      throw new Error('Invalid number of songs to skip.');
    }

    this.manualForward(skip);

    try {
      if (this.getCurrent() && this.status !== STATUS.PAUSED) {
        await this.play();
      } else {
        this.status = STATUS.IDLE;
        this.audioPlayer?.stop(true);

        const settings = await getGuildSettings(this.guildId);

        const {secondsToWaitAfterQueueEmpties} = settings;
        if (secondsToWaitAfterQueueEmpties !== 0) {
          this.disconnectTimer = setTimeout(() => {
            // Ensure we are not accidentally playing when disconnecting
            if (this.status === STATUS.IDLE) {
              this.disconnect();
            }
          }, secondsToWaitAfterQueueEmpties * 1000);
        }
      }
    } catch (error: unknown) {
      // Revert queue position if an error occurs
      this.queuePosition = Math.max(0, this.queuePosition - skip);
      throw error;
    }
  }

  registerVoiceActivityListener(guildSettings: Awaited<ReturnType<typeof getGuildSettings>>) {
    const {turnDownVolumeWhenPeopleSpeak, turnDownVolumeWhenPeopleSpeakTarget} = guildSettings;
    if (!turnDownVolumeWhenPeopleSpeak || !this.voiceConnection) {
      return;
    }

    this.voiceConnection.receiver.speaking.on('start', (userId: string) => {
      if (!this.currentChannel) {
        return;
      }

      const member = this.currentChannel.members.get(userId);
      const channelId = this.currentChannel?.id;

      if (member) {
        if (!this.channelToSpeakingUsers.has(channelId)) {
          this.channelToSpeakingUsers.set(channelId, new Set());
        }

        this.channelToSpeakingUsers.get(channelId)?.add(member.id);
      }

      this.suppressVoiceWhenPeopleAreSpeaking(turnDownVolumeWhenPeopleSpeakTarget);
    });

    this.voiceConnection.receiver.speaking.on('end', (userId: string) => {
      if (!this.currentChannel) {
        return;
      }

      const member = this.currentChannel.members.get(userId);
      const channelId = this.currentChannel.id;
      if (member) {
        if (!this.channelToSpeakingUsers.has(channelId)) {
          this.channelToSpeakingUsers.set(channelId, new Set());
        }

        this.channelToSpeakingUsers.get(channelId)?.delete(member.id);
      }

      this.suppressVoiceWhenPeopleAreSpeaking(turnDownVolumeWhenPeopleSpeakTarget);
    });
  }

  suppressVoiceWhenPeopleAreSpeaking(turnDownVolumeWhenPeopleSpeakTarget: number): void {
    if (!this.currentChannel) {
      return;
    }

    const speakingUsers = this.channelToSpeakingUsers.get(this.currentChannel.id);
    const currentVol = this.volume || this.defaultVolume;
    const isSpeaking = speakingUsers && speakingUsers.size > 0;
    
    if (isSpeaking) {
      // Only duck if target is lower than current volume
      if (turnDownVolumeWhenPeopleSpeakTarget < currentVol) {
        if (this.preDuckingVolume === null) {
          this.preDuckingVolume = currentVol;
        }
        this.setVolume(turnDownVolumeWhenPeopleSpeakTarget);
      }
    } else if (this.preDuckingVolume !== null) {
      // Restore to volume before ducking started
      this.setVolume(this.preDuckingVolume);
      this.preDuckingVolume = null;
    }
  }

  canGoForward(skip: number) {
    return (this.queuePosition + skip - 1) < this.queue.length;
  }

  manualForward(skip: number): void {
    if (this.canGoForward(skip)) {
      this.queuePosition += skip;
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

  /**
   * Returns queue, not including the current song.
   * @returns {QueuedSong[]}
   */
  getQueue(): QueuedSong[] {
    return this.queue.slice(this.queuePosition + 1);
  }

  add(song: QueuedSong, {immediate = false} = {}): void {
    if (!immediate) {
      // Add to end of queue
      this.queue.push(song);
    } else {
      // Add as the next song to be played
      const insertAt = this.queuePosition + 1;
      this.queue = [...this.queue.slice(0, insertAt), song, ...this.queue.slice(insertAt)];
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
  }

  move(from: number, to: number): QueuedSong {
    if (from > this.queueSize() || to > this.queueSize()) {
      throw new Error('Move index is outside the range of the queue.');
    }

    this.queue.splice(this.queuePosition + to, 0, this.queue.splice(this.queuePosition + from, 1)[0]);

    return this.queue[this.queuePosition + to];
  }

  setVolume(level: number): void {
    // Level should be a number between 0 and 100 = 0% => 100%
    this.volume = level;
    this.setAudioPlayerVolume(level);
  }

  getVolume(): number {
    // Only use default volume if player volume is not already set (in the event of a reconnect we shouldn't reset)
    return this.volume ?? this.defaultVolume;
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
      debug('getStream: pausing existing audio player to replace stream', {status: this.status, nowPlaying: this.nowPlaying?.url});
      this.shouldIgnoreNextIdleEvent = true;
      this.audioPlayer?.stop();
    } else if (this.status === STATUS.PAUSED) {
      debug('getStream: stopping existing audio player (paused) to replace stream', {status: this.status, nowPlaying: this.nowPlaying?.url});
      this.shouldIgnoreNextIdleEvent = true;
      this.audioPlayer?.stop(true);
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
    }
  }

  private attachListeners(): void {
    if (!this.voiceConnection) {
      return;
    }

    if (!this.audioPlayer) {
      return;
    }

    const player = this.audioPlayer;

    debug('attachListeners: binding idle listener', {hasPlayer: !!player});

    if (player.listeners(AudioPlayerStatus.Idle).length === 0) {
      player.on(AudioPlayerStatus.Idle, async (oldState, newState) => {
        debug('audioPlayer Idle event fired', {oldStatus: oldState.status, newStatus: newState.status, nowPlaying: this.nowPlaying?.url});
        // Ignore idle events from players that are no longer active.
        if (this.audioPlayer !== player) {
          debug('audioPlayer Idle: ignored because player instance changed');
          return;
        }

        await this.onAudioPlayerIdle(oldState, newState);
      });
    }
  }

  private async onVoiceConnectionDisconnect(): Promise<void> {
    if (!this.voiceConnection || this.voiceConnection.state.status !== VoiceConnectionStatus.Disconnected) {
      return;
    }

    const disconnectedState = this.voiceConnection.state;
    if (disconnectedState.reason === VoiceConnectionDisconnectReason.WebSocketClose && disconnectedState.closeCode === 4014) {
      try {
        await Promise.race([
          entersState(this.voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
          entersState(this.voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
        ]);
        return;
      } catch {
        this.disconnect();
        return;
      }
    }

    if (this.voiceConnection.rejoinAttempts < 5) {
      await sleep((this.voiceConnection.rejoinAttempts + 1) * 5_000);

      if (this.voiceConnection && this.voiceConnection.state.status === VoiceConnectionStatus.Disconnected) {
        if (this.voiceConnection.rejoin()) {
          return;
        }
      }
    }

    this.disconnect();
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
      this.audioResource = resource;
      this.setAudioPlayerVolume();
      debug('playAudioPlayerResource: calling audioPlayer.play', {url: this.nowPlaying?.url, volume: this.getVolume()});
      this.audioPlayer.play(this.audioResource);
    }
  }

  private setAudioPlayerVolume(level?: number) {
    // Audio resource expects a float between 0 and 1 to represent level percentage
    this.audioResource?.volume?.setVolume((level ?? this.getVolume()) / 100);
  }
}
