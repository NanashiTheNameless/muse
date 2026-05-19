import {execa} from 'execa';
import {constants as fsConstants, promises as fs} from 'fs';
import path from 'path';

const YT_DLP_VERSION_TIMEOUT_MS = 15_000;
const YT_DLP_UPDATE_TIMEOUT_MS = 120_000;
const YT_DLP_EXTRACT_TIMEOUT_MS = 45_000;

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

// Broader client list without POT — tried after the default web client.
const YT_DLP_YOUTUBE_EXTENDED_CLIENTS = 'youtube:player_client=tv,ios,mweb';
// Last-resort args: include formats that are missing POT so yt-dlp can at least find something.
const YT_DLP_YOUTUBE_FALLBACK_ARGS = `${YT_DLP_YOUTUBE_EXTENDED_CLIENTS};formats=missing_pot`;

const YT_DLP_EXTRACT_ATTEMPTS: YtDlpExtractAttempt[] = [
  // Default web client first: cookies (e.g. for age-restricted content) are only effective here.
  // ios/android clients return only storyboard formats for age-restricted videos, so they must
  // come after this attempt.
  {
    label: 'bestaudio (default client)',
    format: 'bestaudio*/bestaudio/b/best',
    sort: 'proto:https',
  },
  {
    label: 'best (default client)',
    format: 'best',
  },
  // Clients that avoid Proof-of-Origin Token (POT) requirements for non-restricted content.
  {
    label: 'bestaudio with extended clients',
    format: 'bestaudio*/bestaudio/b/best',
    sort: 'proto:https',
    extractorArgs: YT_DLP_YOUTUBE_EXTENDED_CLIENTS,
  },
  // Fallback: allow missing-POT formats in case the above clients return nothing.
  {
    label: 'bestaudio with all clients (missing POT)',
    format: 'bestaudio*/bestaudio/b/best',
    extractorArgs: YT_DLP_YOUTUBE_FALLBACK_ARGS,
  },
  {
    label: 'best (fallback clients)',
    format: 'best',
    extractorArgs: YT_DLP_YOUTUBE_FALLBACK_ARGS,
  },
  {
    label: 'automatic selection',
  },
];

const firstNonEmpty = (...values: Array<string | undefined>) => values
  .map(value => value?.trim())
  .find((value): value is string => Boolean(value));

export const getExecutable = () => {
  const configuredPath = firstNonEmpty(process.env.YT_DLP_PATH, process.env.MUSE_BUNDLED_YT_DLP_PATH);

  return configuredPath ?? 'yt-dlp';
};

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

const getYtDlpCookieArgs = () => {
  const cookiesPath = process.env.YT_DLP_COOKIES_PATH?.trim();

  return cookiesPath ? ['--cookies', cookiesPath] : [];
};

const getYtDlpExtractArgs = (attempt: YtDlpExtractAttempt, videoIdOrUrl: string) => [
  '--dump-single-json',
  '--ignore-config',
  '--js-runtimes',
  'deno:/usr/local/bin/deno',
  '--no-playlist',
  '--skip-download',
  '--no-warnings',
  '--no-cache-dir',
  ...getYtDlpCookieArgs(),
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
    'yt-dlp',
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

const extractYouTubeMediaSource = async (videoIdOrUrl: string, attempt: YtDlpExtractAttempt): Promise<YtDlpMediaSource> => {
  const {stdout} = await execa(getExecutable(), getYtDlpExtractArgs(attempt, videoIdOrUrl), {
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

export const getYouTubeMediaSource = async (videoIdOrUrl: string): Promise<YtDlpMediaSource> => {
  const errors: string[] = [];

  for (const attempt of YT_DLP_EXTRACT_ATTEMPTS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await extractYouTubeMediaSource(videoIdOrUrl, attempt);
    } catch (error: unknown) {
      errors.push(`${attempt.label}: ${getExecaErrorMessage(error)}`);
    }
  }

  // All attempts failed — return a single composed error with the collected reasons.
  throw new Error(`yt-dlp failed to extract media: ${errors.join(' | ')}`);
};
