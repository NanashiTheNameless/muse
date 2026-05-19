// This script is mainly used during development.
// Starts Muse without applying database migrations.
import {startBot} from '../index.js';

(async () => {
  await startBot();
})();
