import {execa} from 'execa';
import {constants as fsConstants, promises as fs} from 'fs';
import {tmpdir} from 'os';
import path from 'path';

const YT_DLP_VERSION_TIMEOUT_MS = 15_000;
const YT_DLP_UPDATE_TIMEOUT_MS = 120_000;
const YT_DLP_EXTRACT_TIMEOUT_MS = 120_000;

interface YtDlpMediaDownload {
  readonly url?: string;
  readonly protocol?: string;
  readonly ext?: string;
  readonly acodec?: string;
  readonly vcodec?: string;
  readonly abr?: number;
  readonly tbr?: number;
  readonly filesize?: number;
  readonly filesize_approx?: number;
  readonly http_headers?: Record<string, string | null | undefined>;
}

interface YtDlpResponse extends YtDlpMediaDownload {
  readonly is_live?: boolean;
  readonly live_status?: string;
  readonly requested_downloads?: readonly YtDlpMediaDownload[];
  readonly formats?: readonly YtDlpMediaDownload[];
}

export interface YtDlpMediaSource {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly isLive: boolean;
}

export interface YtDlpUpdateResult {
  readonly beforeVersion: string | null;
  readonly afterVersion: string | null;
  readonly updated: boolean;
  readonly skipped: boolean;
  readonly updateSucceeded: boolean;
  readonly error?: string;
}

interface YtDlpExtractAttempt {
  readonly label: string;
  readonly format?: string;
  readonly sort?: string;
  readonly extractorArgs?: string;
}
// Broader client list without POT - tried after the default web client.
const YT_DLP_YOUTUBE_EXTENDED_CLIENTS = 'youtube:player_client=tv,ios,mweb';
// Last-resort args: include formats that are missing POT so yt-dlp can at least find something.
const YT_DLP_YOUTUBE_FALLBACK_ARGS = `${YT_DLP_YOUTUBE_EXTENDED_CLIENTS};formats=missing_pot`;

// Simplified extraction attempts. We no longer support age-restricted flows so
// the JS runtime is always enabled to allow JS-based extractors to run.
const YT_DLP_EXTRACT_ATTEMPTS: YtDlpExtractAttempt[] = [
  {
    label: 'bestaudio',
    format: 'bestaudio*/bestaudio/b/best',
    sort: 'proto:https',
  },
  {
    label: 'best',
    format: 'best',
  },
  {
    label: 'bestaudio with extended clients',
    format: 'bestaudio*/bestaudio/b/best',
    sort: 'proto:https',
    extractorArgs: YT_DLP_YOUTUBE_EXTENDED_CLIENTS,
  },
  {
    label: 'bestaudio with all clients (missing POT)',
    format: 'bestaudio*/bestaudio/b/best',
    extractorArgs: YT_DLP_YOUTUBE_FALLBACK_ARGS,
  },
  {
    label: 'automatic selection',
  },
];

export type YtDlpMediaUnavailableReason = 'age-restricted' | 'unavailable';

export class YtDlpMediaUnavailableError extends Error {
  readonly reason: YtDlpMediaUnavailableReason;

  constructor(message: string, reason: YtDlpMediaUnavailableReason = 'unavailable') {
    super(message);
    this.name = 'YtDlpMediaUnavailableError';
    this.reason = reason;
  }
}

const getMediaUnavailableReason = (detail: string): YtDlpMediaUnavailableReason | null => {
  if (/sign in to confirm your age/i.test(detail)) {
    return 'age-restricted';
  }

  return [
    /this video is not available/i,
    /video unavailable/i,
    /private video/i,
    /video has been removed/i,
    /members-only content/i,
  ].some(pattern => pattern.test(detail))
    ? 'unavailable'
    : null;
};

const firstNonEmpty = (...values: Array<string | undefined>) => values
  .map(value => value?.trim())
  .find((value): value is string => Boolean(value));

const withTemporaryCookies = async <T>(operation: (cookiesPath?: string) => Promise<T>): Promise<T> => {
  const configuredCookiesPath = firstNonEmpty(process.env.YT_DLP_COOKIES_PATH);
  if (!configuredCookiesPath) {
    return operation();
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(tmpdir(), 'muse-yt-dlp-'));
  const temporaryCookiesPath = path.join(temporaryDirectory, 'youtube-cookies.txt');

  try {
    await fs.chmod(temporaryDirectory, 0o700);
    await fs.copyFile(configuredCookiesPath, temporaryCookiesPath, fsConstants.COPYFILE_EXCL);
    await fs.chmod(temporaryCookiesPath, 0o600);

    return await operation(temporaryCookiesPath);
  } finally {
    await fs.rm(temporaryDirectory, {recursive: true, force: true});
  }
};

export const getExecutable = () => {
  const configuredPath = firstNonEmpty(process.env.YT_DLP_PATH, process.env.MUSE_BUNDLED_YT_DLP_PATH);

  return configuredPath ?? 'yt-dlp';
};

// Path to the repository-level yt-dlp config file. Can be overridden with
// the MUSE_YT_DLP_CONFIG_PATH environment variable.
const DEFAULT_YT_DLP_CONFIG_PATH = (process.env.MUSE_YT_DLP_CONFIG_PATH && process.env.MUSE_YT_DLP_CONFIG_PATH.trim())
  || path.resolve(process.cwd(), 'yt-dlp.conf');

const getExecaErrorMessage = (error: unknown) => {
  if (isExecaError(error)) {
    const stderr = error.stderr?.trim();

    return stderr ? stderr : (error.shortMessage ?? 'Unknown yt-dlp error');
  }

  return error instanceof Error ? error.message : 'Unknown yt-dlp error';
};

const normalizeHeaders = (headers?: Record<string, string | null | undefined>) => {
  const normalizedEntries = Object.entries(headers ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');

  return Object.fromEntries(normalizedEntries);
};

const isExecaError = (error: unknown): error is {stderr?: string; shortMessage?: string} => (
  typeof error === 'object'
  && error !== null
  && ('stderr' in error || 'shortMessage' in error)
);

const toYouTubeWatchUrl = (videoIdOrUrl: string) => videoIdOrUrl.length === 11
  ? `https://www.youtube.com/watch?v=${videoIdOrUrl}`
  : videoIdOrUrl;

const getYtDlpExtractArgs = (attempt: YtDlpExtractAttempt, videoIdOrUrl: string, cookiesPath?: string) => [
  '--config-location', DEFAULT_YT_DLP_CONFIG_PATH,
  ...(cookiesPath ? ['--cookies', cookiesPath] : []),
  ...(attempt.format ? ['-f', attempt.format] : []),
  ...(attempt.sort ? ['-S', attempt.sort] : []),
  ...(attempt.extractorArgs ? ['--extractor-args', attempt.extractorArgs] : []),
  toYouTubeWatchUrl(videoIdOrUrl),
];

export const getYtDlpVersion = async (): Promise<string> => {
  const {stdout} = await execa(getExecutable(), ['--version'], {
    timeout: YT_DLP_VERSION_TIMEOUT_MS,
  });

  return stdout.trim();
};

const pathExists = async (candidatePath: string, mode = fsConstants.F_OK) => {
  try {
    await fs.access(candidatePath, mode);
    return true;
  } catch {
    return false;
  }
};

const hasPathSeparator = (candidatePath: string) => candidatePath.includes('/') || candidatePath.includes('\\');

const getCommandCandidates = (command: string) => {
  if (process.platform !== 'win32' || path.extname(command)) {
    return [command];
  }

  const executableExtensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map(extension => `${command}${extension.toLowerCase()}`);

  return [command, ...executableExtensions];
};

const findExecutableOnPath = async (command: string) => {
  const directories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean);

  for (const directory of directories) {
    for (const candidate of getCommandCandidates(command)) {
      const candidatePath = path.join(directory, candidate);
      // eslint-disable-next-line no-await-in-loop
      if (await pathExists(candidatePath, fsConstants.X_OK)) {
        return candidatePath;
      }
    }
  }

  return null;
};

const resolveExecutablePath = async () => {
  const executable = getExecutable();

  if (path.isAbsolute(executable)) {
    return executable;
  }

  if (hasPathSeparator(executable)) {
    return path.resolve(executable);
  }

  return findExecutableOnPath(executable);
};

const getPythonExecutableForYtDlp = async () => {
  const executable = await resolveExecutablePath();
  if (!executable) {
    return null;
  }

  const realExecutable = await fs.realpath(executable);
  const binDirectory = path.dirname(realExecutable);
  const pythonExecutable = path.join(binDirectory, process.platform === 'win32' ? 'python.exe' : 'python');

  return (await pathExists(pythonExecutable)) ? pythonExecutable : null;
};

const updateWithPip = async () => {
  const pythonExecutable = await getPythonExecutableForYtDlp();
  if (!pythonExecutable) {
    return false;
  }

  await execa(pythonExecutable, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-input',
    '--upgrade',
    'yt-dlp[default]',
  ], {
    env: {
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_INPUT: '1',
    },
    timeout: YT_DLP_UPDATE_TIMEOUT_MS,
  });
  return true;
};

const updateWithYtDlpSelfUpdate = async () => {
  await execa(getExecutable(), ['-U'], {
    timeout: YT_DLP_UPDATE_TIMEOUT_MS,
  });
  return true;
};

const joinErrors = (errors: string[]) => errors.length > 0 ? errors.join('; ') : undefined;

const PLAYABLE_PROTOCOLS = new Set([
  'http',
  'https',
  'm3u8',
  'm3u8_native',
  'dash',
  'http_dash_segments',
]);

const isPlayableProtocol = (protocol?: string) => {
  if (!protocol) {
    return true;
  }

  // ffmpeg can consume direct HTTP(S), HLS, and DASH manifest inputs.
  return PLAYABLE_PROTOCOLS.has(protocol);
};

const hasPlayableUrl = (download: YtDlpMediaDownload) => Boolean(download.url) && isPlayableProtocol(download.protocol);

const getAudioScore = (download: YtDlpMediaDownload) => download.abr ?? download.tbr ?? 0;

const getSizeScore = (download: YtDlpMediaDownload) => download.filesize ?? download.filesize_approx ?? 0;

const pickBestMediaDownload = (response: YtDlpResponse) => {
  const requestedDownloads = (response.requested_downloads ?? []).filter(hasPlayableUrl);

  const rankDownloads = (downloads: YtDlpMediaDownload[]) => downloads
    .slice()
    .sort((left, right) => {
      const audioScoreDifference = getAudioScore(right) - getAudioScore(left);
      if (audioScoreDifference !== 0) {
        return audioScoreDifference;
      }

      return getSizeScore(right) - getSizeScore(left);
    });

  if (requestedDownloads.length > 0) {
    // Rank requested downloads same as formats
    return rankDownloads(requestedDownloads).at(0);
  }

  if (hasPlayableUrl(response)) {
    return response;
  }

  const playableFormats = response.formats?.filter(hasPlayableUrl) ?? [];
  const audioOnlyFormats = playableFormats.filter(format => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none'));
  const formatsToRank = audioOnlyFormats.length > 0
    ? audioOnlyFormats
    : playableFormats.filter(format => format.acodec && format.acodec !== 'none');

  return rankDownloads(formatsToRank).at(0);
};

export const updateYtDlp = async (): Promise<YtDlpUpdateResult> => {
  let beforeVersion: string | null = null;
  try {
    beforeVersion = await getYtDlpVersion();
  } catch {
    // If version probing fails, still try the configured updater below.
  }

  const errors: string[] = [];
  let attemptedUpdate = false;
  let updateSucceeded = false;

  try {
    const didAttemptUpdate = await updateWithPip();
    if (didAttemptUpdate) {
      attemptedUpdate = true;
      updateSucceeded = true;
    }
  } catch (error: unknown) {
    attemptedUpdate = true;
    errors.push(getExecaErrorMessage(error));
  }

  if (!updateSucceeded) {
    try {
      await updateWithYtDlpSelfUpdate();
      attemptedUpdate = true;
      updateSucceeded = true;
    } catch (error: unknown) {
      attemptedUpdate = true;
      errors.push(getExecaErrorMessage(error));
    }
  }

  let afterVersion: string | null = null;
  try {
    afterVersion = await getYtDlpVersion();
  } catch (error: unknown) {
    const updateErrors = updateSucceeded ? [] : errors;

    return {
      beforeVersion,
      afterVersion,
      updated: false,
      skipped: !attemptedUpdate,
      updateSucceeded,
      error: joinErrors([...updateErrors, getExecaErrorMessage(error)]),
    };
  }

  const error = updateSucceeded ? undefined : joinErrors(errors);

  return {
    beforeVersion,
    afterVersion,
    updated: beforeVersion !== null && beforeVersion !== afterVersion,
    skipped: !attemptedUpdate,
    updateSucceeded,
    error,
  };
};

const extractYouTubeMediaSource = async (videoIdOrUrl: string, attempt: YtDlpExtractAttempt, cookiesPath?: string): Promise<YtDlpMediaSource> => {
  const {stdout} = await execa(getExecutable(), getYtDlpExtractArgs(attempt, videoIdOrUrl, cookiesPath), {
    timeout: YT_DLP_EXTRACT_TIMEOUT_MS,
  });

  const response = JSON.parse(stdout) as YtDlpResponse;
  const download = pickBestMediaDownload(response);

  if (!download?.url) {
    throw new Error('yt-dlp did not return a playable media URL.');
  }

  return {
    url: download.url,
    headers: normalizeHeaders(download.http_headers ?? response.http_headers),
    isLive: Boolean(response.is_live ?? (response.live_status === 'is_live')),
  };
};

export const getYouTubeMediaSource = async (videoIdOrUrl: string): Promise<YtDlpMediaSource> => withTemporaryCookies(async cookiesPath => {
  const errors: string[] = [];
  let unavailableReason: YtDlpMediaUnavailableReason | null = null;

  for (const attempt of YT_DLP_EXTRACT_ATTEMPTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await extractYouTubeMediaSource(videoIdOrUrl, attempt, cookiesPath);
    } catch (error: unknown) {
      const detail = getExecaErrorMessage(error);
      errors.push(`${attempt.label}: ${detail}`);
      unavailableReason ??= getMediaUnavailableReason(detail);
    }
  }

  // All attempts failed - return a single composed error with the collected reasons.
  const message = `yt-dlp failed to extract media: ${errors.join(' | ')}`;

  if (unavailableReason) {
    throw new YtDlpMediaUnavailableError(message, unavailableReason);
  }

  throw new Error(message);
});
