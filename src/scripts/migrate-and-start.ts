// This script applies Prisma migrations
// and then starts Muse.
import {execa, ExecaError} from 'execa';
import {promises as fs} from 'fs';
import Prisma from '@prisma/client';
import {PrismaBetterSqlite3} from '@prisma/adapter-better-sqlite3';
import {startBot} from '../index.js';
import createDatabaseUrl, {createDatabasePath} from '../utils/create-database-url.js';
import {DATA_DIR} from '../services/config.js';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? createDatabaseUrl(DATA_DIR);

const migrateFromSequelizeToPrisma = async () => {
  await execa('prisma', ['migrate', 'resolve', '--applied', '20220101155430_migrate_from_sequelize'], {preferLocal: true});
};

const doesUserHaveExistingDatabase = async () => {
  try {
    await fs.access(createDatabasePath(DATA_DIR));

    return true;
  } catch {
    return false;
  }
};

const hasDatabaseBeenMigratedToPrisma = async () => {
  const client = new Prisma.PrismaClient({
    adapter: new PrismaBetterSqlite3({url: process.env.DATABASE_URL}),
  });

  try {
    await client.$queryRaw`SELECT COUNT(id) FROM _prisma_migrations`;
  } catch (error: unknown) {
    if (error instanceof Prisma.Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
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
  const client = new Prisma.PrismaClient({
    adapter: new PrismaBetterSqlite3({url: process.env.DATABASE_URL}),
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
    return failedMigrations.map((migration) => migration.migration_name);
  } catch (error: unknown) {
    if (error instanceof Prisma.Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
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
  console.log('Applying database migrations...');

  if (await doesUserHaveExistingDatabase()) {
    if (!(await hasDatabaseBeenMigratedToPrisma())) {
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
    }
  }

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

  console.log('Database migrations applied.');

  await startBot();
})();
