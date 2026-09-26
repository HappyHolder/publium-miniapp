-- CreateTable
CREATE TABLE "CollaberProfile" (
    "id" TEXT NOT NULL,
    "communityManagerId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "searchable" BOOLEAN NOT NULL DEFAULT true,
    "publicMentions" BOOLEAN NOT NULL DEFAULT false,
    "forgotten" BOOLEAN NOT NULL DEFAULT false,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "sourceText" TEXT NOT NULL DEFAULT '',
    "sourceMessageId" INTEGER,
    "sourceAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "lastProposedAt" TIMESTAMP(3),
    "membership" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaberProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaberImport" (
    "id" TEXT NOT NULL,
    "communityManagerId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEW',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "total" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "profiles" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaberImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaberTask" (
    "id" TEXT NOT NULL,
    "communityManagerId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaberTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaberRequest" (
    "id" TEXT NOT NULL,
    "communityManagerId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "sourceMessageId" INTEGER,
    "query" TEXT NOT NULL,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "initiative" BOOLEAN NOT NULL DEFAULT false,
    "response" TEXT,
    "telegramMessageId" INTEGER,
    "feedback" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaberRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaberSession" (
    "id" TEXT NOT NULL,
    "communityManagerId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'SEARCH',
    "query" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaberSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaberInvite" (
    "id" TEXT NOT NULL,
    "communityManagerId" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollaberInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollaberProfile_participantId_key" ON "CollaberProfile"("participantId");

-- CreateIndex
CREATE INDEX "CollaberProfile_communityManagerId_searchable_sourceAt_idx" ON "CollaberProfile"("communityManagerId", "searchable", "sourceAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollaberProfile_communityManagerId_tgUserId_key" ON "CollaberProfile"("communityManagerId", "tgUserId");

-- CreateIndex
CREATE INDEX "CollaberImport_status_createdAt_idx" ON "CollaberImport"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollaberImport_communityManagerId_checksum_key" ON "CollaberImport"("communityManagerId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "CollaberTask_dedupeKey_key" ON "CollaberTask"("dedupeKey");

-- CreateIndex
CREATE INDEX "CollaberTask_status_runAfter_idx" ON "CollaberTask"("status", "runAfter");

-- CreateIndex
CREATE UNIQUE INDEX "CollaberRequest_dedupeKey_key" ON "CollaberRequest"("dedupeKey");

-- CreateIndex
CREATE INDEX "CollaberRequest_communityManagerId_createdAt_idx" ON "CollaberRequest"("communityManagerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollaberSession_botId_tgUserId_key" ON "CollaberSession"("botId", "tgUserId");

-- CreateIndex
CREATE INDEX "CollaberInvite_communityManagerId_status_idx" ON "CollaberInvite"("communityManagerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CollaberInvite_communityManagerId_pairKey_key" ON "CollaberInvite"("communityManagerId", "pairKey");

-- AddForeignKey
ALTER TABLE "CollaberProfile" ADD CONSTRAINT "CollaberProfile_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaberProfile" ADD CONSTRAINT "CollaberProfile_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "CommunityManagerParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaberImport" ADD CONSTRAINT "CollaberImport_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaberTask" ADD CONSTRAINT "CollaberTask_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaberRequest" ADD CONSTRAINT "CollaberRequest_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaberSession" ADD CONSTRAINT "CollaberSession_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaberInvite" ADD CONSTRAINT "CollaberInvite_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;
