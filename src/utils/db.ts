import {PrismaClient} from '@prisma/client';
import {PrismaBetterSqlite3} from '@prisma/adapter-better-sqlite3';
import {DATA_DIR} from '../services/config.js';
import createDatabaseUrl from './create-database-url.js';

if (!process.env.DATABASE_URL?.trim()) {
	process.env.DATABASE_URL = createDatabaseUrl(DATA_DIR);
}

const adapter = new PrismaBetterSqlite3({url: process.env.DATABASE_URL});

export const prisma = new PrismaClient({adapter});
