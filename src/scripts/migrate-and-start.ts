// This script applies Prisma migrations
// and then starts Muse.
import {execa, ExecaError} from 'execa';
import {promises as fs} from 'fs';
import * as Prisma from '@prisma/client';
import {PrismaBetterSqlite3} from '@prisma/adapter-better-sqlite3';
import {startBot} from '../index.js';
import createDatabaseUrl, {createDatabasePathFromUrl} from '../utils/create-database-url.js';
import {DATA_DIR} from '../services/config.js';
import {runMigrationsAndStart} from '../utils/run-migrations-and-start.js';

const databaseUrl = process.env.DATABASE_URL ?? createDatabaseUrl(DATA_DIR);
process.env.DATABASE_URL = databaseUrl;

const isRunningInContainer = async () => {
  try {
    // Docker typically creates /.dockerenv
    await fs.access('/.dockerenv');
    return true;
  } catch {
    // ignore
  }

  try {
    const cgroup = await fs.readFile('/proc/1/cgroup', 'utf8');
    return /docker|kubepods|containerd|lxc|podman/.test(cgroup);
  } catch {
    return false;
  }
};

const migrateFromSequelizeToPrisma = async () => {
  await execa('prisma', ['migrate', 'resolve', '--applied', '20220101155430_migrate_from_sequelize'], {preferLocal: true});
};

const doesUserHaveExistingDatabase = async () => {
  try {
    await fs.access(createDatabasePathFromUrl(databaseUrl));

    return true;
  } catch {
    return false;
  }
};

const hasDatabaseBeenMigratedToPrisma = async () => {
  const PrismaPkg: any = Prisma as any;
  const PrismaClientCtor = PrismaPkg.PrismaClient ?? PrismaPkg.default ?? PrismaPkg;
  const client = new PrismaClientCtor({
    adapter: new PrismaBetterSqlite3({url: `file:${createDatabasePathFromUrl(process.env.DATABASE_URL!)}`}),
  });

  try {
    await client.$queryRaw`SELECT COUNT(id) FROM _prisma_migrations`;
  } catch (error: unknown) {
    const e: any = error;
    if (e && e.code === 'P2010') {
      // Table doesn't exist
      await client.$disconnect();
      return false;
    }

    await client.$disconnect();
    throw error;
  }

  await client.$disconnect();
  return true;
};

const getFailedPrismaMigrations = async () => {
  const PrismaPkg2: any = Prisma as any;
  const PrismaClientCtor2 = PrismaPkg2.PrismaClient ?? PrismaPkg2.default ?? PrismaPkg2;
  const client = new PrismaClientCtor2({
    adapter: new PrismaBetterSqlite3({url: `file:${createDatabasePathFromUrl(process.env.DATABASE_URL!)}`}),
  });

  try {
    const failedMigrations = await client.$queryRaw<Array<{migration_name: string}>>`
      SELECT migration_name
      FROM _prisma_migrations
      WHERE finished_at IS NULL
        AND rolled_back_at IS NULL
      ORDER BY started_at ASC
    `;

    await client.$disconnect();
    return failedMigrations.map((migration: any) => migration.migration_name);
  } catch (error: unknown) {
    const e: any = error;
    if (e && e.code === 'P2010') {
      await client.$disconnect();
      return [];
    }

    await client.$disconnect();
    throw error;
  }
};

const resolveFailedMigrations = async () => {
  const failedMigrations = await getFailedPrismaMigrations();

  if (failedMigrations.length === 0) {
    return;
  }

  console.warn(`Found ${failedMigrations.length} failed Prisma migration(s). Marking as rolled back before deploy.`);

  for (const migration of failedMigrations) {
    await execa('prisma', ['migrate', 'resolve', '--rolled-back', migration], {preferLocal: true});
  }
};

(async () => {

  if (!(await isRunningInContainer())) {
    console.warn('Warning: Muse is intended to run inside a Docker container. Waiting 60s before continuing...');
    await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
  }

  console.log('Applying database migrations...');

  await runMigrationsAndStart({
    databaseExists: doesUserHaveExistingDatabase,
    hasPrismaMigrations: hasDatabaseBeenMigratedToPrisma,
    resolveInitialMigration: async () => {
      try {
        await migrateFromSequelizeToPrisma();
      } catch (error) {
        if ((error as ExecaError).stderr) {
          console.error('Failed to apply database migrations (going from Sequelize to Prisma):');
          console.error((error as ExecaError).stderr);
          process.exit(1);
        } else {
          throw error;
        }
      }
    },
    deployMigrations: async () => {
      try {
        await resolveFailedMigrations();
      } catch (error) {
        if ((error as ExecaError).stderr) {
          console.error('Failed to resolve previously failed migrations:');
          console.error((error as ExecaError).stderr);
          process.exit(1);
        } else {
          throw error;
        }
      }

      try {
        await execa('prisma', ['migrate', 'deploy'], {preferLocal: true});
      } catch (error: unknown) {
        if ((error as ExecaError).stderr) {
          console.error('Failed to apply database migrations:');
          console.error((error as ExecaError).stderr);
          process.exit(1);
        } else {
          throw error;
        }
      }
    },
    migrationsApplied: () => console.log('Database migrations applied.'),
    startBot,
  });
})();
