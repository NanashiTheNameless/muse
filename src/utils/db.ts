import * as Prisma from '@prisma/client';
import {PrismaBetterSqlite3} from '@prisma/adapter-better-sqlite3';
import {DATA_DIR} from '../services/config.js';
import createDatabaseUrl, {createDatabasePathFromUrl} from './create-database-url.js';

if (!process.env.DATABASE_URL?.trim()) {
	process.env.DATABASE_URL = createDatabaseUrl(DATA_DIR);
}

// The better-sqlite3 adapter treats query params as part of the file name,
// so strip them - otherwise we'd open a different file than prisma migrate.
const adapter = new PrismaBetterSqlite3({url: `file:${createDatabasePathFromUrl(process.env.DATABASE_URL!)}`});

const PrismaPkg: any = Prisma as any;
const PrismaClientCtor = PrismaPkg.PrismaClient ?? PrismaPkg.default ?? PrismaPkg;

export const prisma = new PrismaClientCtor({adapter});
