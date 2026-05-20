-- CreateTable
CREATE TABLE "FileCache" (
    "hash" TEXT NOT NULL PRIMARY KEY,
    "bytes" INTEGER NOT NULL,
    "accessedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KeyValueCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Setting" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "playlistLimit" INTEGER NOT NULL DEFAULT 50,
    "secondsToWaitAfterQueueEmpties" INTEGER NOT NULL DEFAULT 120,
    "leaveIfNoListeners" BOOLEAN NOT NULL DEFAULT true,
    "queueAddResponseEphemeral" BOOLEAN NOT NULL DEFAULT false,
    "autoAnnounceNextSong" BOOLEAN NOT NULL DEFAULT true,
    "defaultVolume" INTEGER NOT NULL DEFAULT 25,
    "defaultQueuePageSize" INTEGER NOT NULL DEFAULT 10,
    "volumeDucking" BOOLEAN NOT NULL DEFAULT true,
    "volumeDuckingTarget" INTEGER NOT NULL DEFAULT 10,
    "volumeDuckingThreshold" INTEGER NOT NULL DEFAULT 50,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FavoriteQuery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "guildId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "FavoriteQuery_guildId_name_key" ON "FavoriteQuery"("guildId", "name");
