// Prisma v7 CommonJS config. Prisma CLI parses this during generate/migrate.
module.exports = {
  datasources: {
    db: {
      provider: 'sqlite',
      url: process.env.DATABASE_URL || 'file:./dev.db',
    },
  },
};
