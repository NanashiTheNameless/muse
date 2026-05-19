import {makeDirectory} from 'make-dir';
import path from 'path';
import container from './inversify.config.js';
import {TYPES} from './types.js';
import Bot from './bot.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import prepareYtDlp from './utils/prepare-yt-dlp.js';
import prepareRuntimeTools from './utils/prepare-runtime-tools.js';

const bot = container.get<Bot>(TYPES.Bot);

const startBot = async () => {
  // Create data directories if necessary
  const config = container.get<Config>(TYPES.Config);

  await makeDirectory(config.DATA_DIR);
  await makeDirectory(config.CACHE_DIR);
  await makeDirectory(path.join(config.CACHE_DIR, 'tmp'));

  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();
  await prepareYtDlp(config);
  await prepareRuntimeTools();

  await bot.register();
};

export {startBot};
