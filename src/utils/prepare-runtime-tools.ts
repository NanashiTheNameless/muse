import {execa} from 'execa';

interface RuntimeTool {
  readonly label: string;
  readonly executable: string;
  readonly args: readonly string[];
}

const RUNTIME_TOOLS: RuntimeTool[] = [
  {
    label: 'FFMPEG_VERSION',
    executable: 'ffmpeg',
    args: ['-version'],
  },
  {
    label: 'FFPROBE_VERSION',
    executable: 'ffprobe',
    args: ['-version'],
  },
  {
    label: 'DENO_VERSION',
    executable: 'deno',
    args: ['--version'],
  },
  {
    label: 'YT_DLP_EJS_VERSION',
    executable: 'yt-dlp-ejs',
    args: ['--version'],
  },
];

const getErrorMessage = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'shortMessage' in error && typeof error.shortMessage === 'string') {
    return error.shortMessage;
  }

  return error instanceof Error ? error.message : 'unknown error';
};

const toVersionLine = (output: string) => output
  .split('\n')
  .map(line => line.trim())
  .find(Boolean);

export default async function prepareRuntimeTools(): Promise<void> {
  for (const tool of RUNTIME_TOOLS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const {stdout, stderr} = await execa(tool.executable, [...tool.args], {timeout: 15_000});
      const version = toVersionLine(stdout) ?? toVersionLine(stderr) ?? 'unknown';

      console.log(`${tool.label}=${version} (${tool.executable})`);
    } catch (error: unknown) {
      console.warn(`${tool.label}=unavailable (${tool.executable}: ${getErrorMessage(error)})`);
    }
  }
}
