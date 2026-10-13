-- AlterTable
ALTER TABLE "CommunityDailyParticipant" ADD COLUMN     "estimated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CommunityDailyStat" ADD COLUMN "memberCountAt" TIMESTAMP(3), ADD COLUMN "memberCountSource" TEXT;

-- CreateTable
CREATE TABLE "PulseMessage" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "telegramMessageId" INTEGER NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "isReply" BOOLEAN NOT NULL,
    "replyToMessageId" INTEGER,
    "replyToUserId" TEXT,
    "replyToBot" BOOLEAN NOT NULL DEFAULT false,
    "actorKind" TEXT NOT NULL DEFAULT 'HUMAN',
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PulseMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseMembership" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "firstJoin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PulseMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseCoverage" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "maxGapMs" INTEGER NOT NULL DEFAULT 0,
    "healthy" BOOLEAN NOT NULL,
    "membership" BOOLEAN NOT NULL,

    CONSTRAINT "PulseCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseAssessment" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "analysisKey" TEXT NOT NULL,
    "assessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messageIds" JSONB NOT NULL,
    "evidenceIds" JSONB NOT NULL,
    "targetIds" JSONB NOT NULL,
    "categories" JSONB NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PulseAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PulseModerationRecord" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "facts" JSONB NOT NULL,

    CONSTRAINT "PulseModerationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PulseMessage_communityId_sentAt_idx" ON "PulseMessage"("communityId", "sentAt");

-- CreateIndex
CREATE INDEX "PulseMessage_communityId_tgUserId_sentAt_idx" ON "PulseMessage"("communityId", "tgUserId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "PulseMessage_communityId_telegramMessageId_key" ON "PulseMessage"("communityId", "telegramMessageId");

-- CreateIndex
CREATE INDEX "PulseMembership_communityId_occurredAt_idx" ON "PulseMembership"("communityId", "occurredAt");

-- CreateIndex
CREATE INDEX "PulseMembership_communityId_tgUserId_occurredAt_idx" ON "PulseMembership"("communityId", "tgUserId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PulseMembership_communityId_tgUserId_kind_occurredAt_key" ON "PulseMembership"("communityId", "tgUserId", "kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "PulseCoverage_communityId_day_key" ON "PulseCoverage"("communityId", "day");

-- CreateIndex
CREATE INDEX "PulseAssessment_communityId_assessedAt_idx" ON "PulseAssessment"("communityId", "assessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PulseAssessment_communityId_analysisKey_key" ON "PulseAssessment"("communityId", "analysisKey");

-- CreateIndex
CREATE INDEX "PulseModerationRecord_communityId_occurredAt_idx" ON "PulseModerationRecord"("communityId", "occurredAt");
CREATE INDEX "PulseMessage_sentAt_idx" ON "PulseMessage"("sentAt");
CREATE INDEX "PulseCoverage_day_idx" ON "PulseCoverage"("day");
CREATE INDEX "PulseAssessment_assessedAt_idx" ON "PulseAssessment"("assessedAt");
CREATE INDEX "PulseModerationRecord_occurredAt_idx" ON "PulseModerationRecord"("occurredAt");

-- AddForeignKey
ALTER TABLE "PulseMessage" ADD CONSTRAINT "PulseMessage_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseMembership" ADD CONSTRAINT "PulseMembership_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseCoverage" ADD CONSTRAINT "PulseCoverage_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseAssessment" ADD CONSTRAINT "PulseAssessment_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PulseModerationRecord" ADD CONSTRAINT "PulseModerationRecord_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;
