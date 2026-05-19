// Prisma v7 config — loaded by Prisma CLI during generate/migrate.
// Uses plain export default (no defineConfig import needed) to avoid
// any ESM/CJS resolution issues at generate-time.
export default {
  schema: 'schema.prisma',
  migrations: {
    path: 'migrations',
  },
  datasource: {
    // Use process.env directly (not env() helper) so prisma generate
    // doesn't throw when DATABASE_URL is unset in CI/Docker build.
    url: process.env.DATABASE_URL ?? 'file:./dev.db',
  },
};
