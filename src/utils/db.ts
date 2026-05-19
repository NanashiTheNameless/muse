import {PrismaClient} from '@prisma/client';
import {DATA_DIR} from '../services/config.js';
import createDatabaseUrl from './create-database-url.js';

if (!process.env.DATABASE_URL?.trim()) {
	process.env.DATABASE_URL = createDatabaseUrl(DATA_DIR);
}

export const prisma = new PrismaClient();
