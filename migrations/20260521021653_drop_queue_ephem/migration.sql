/*
  Warnings:

  - You are about to drop the column `queueAddResponseEphemeral` on the `Setting` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Setting" (
    "guildId" TEXT NOT NULL PRIMARY KEY,
    "playlistLimit" INTEGER NOT NULL DEFAULT 50,
    "secondsToWaitAfterQueueEmpties" INTEGER NOT NULL DEFAULT 120,
    "leaveIfNoListeners" BOOLEAN NOT NULL DEFAULT true,
    "autoAnnounceNextSong" BOOLEAN NOT NULL DEFAULT true,
    "defaultVolume" INTEGER NOT NULL DEFAULT 25,
    "defaultQueuePageSize" INTEGER NOT NULL DEFAULT 10,
    "volumeDucking" BOOLEAN NOT NULL DEFAULT true,
    "volumeDuckingTarget" INTEGER NOT NULL DEFAULT 10,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Setting" ("autoAnnounceNextSong", "createdAt", "defaultQueuePageSize", "defaultVolume", "guildId", "leaveIfNoListeners", "playlistLimit", "secondsToWaitAfterQueueEmpties", "updatedAt", "volumeDucking", "volumeDuckingTarget") SELECT "autoAnnounceNextSong", "createdAt", "defaultQueuePageSize", "defaultVolume", "guildId", "leaveIfNoListeners", "playlistLimit", "secondsToWaitAfterQueueEmpties", "updatedAt", "volumeDucking", "volumeDuckingTarget" FROM "Setting";
DROP TABLE "Setting";
ALTER TABLE "new_Setting" RENAME TO "Setting";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
