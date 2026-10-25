ALTER TABLE "ModeratorConversationMessage"
  ADD COLUMN "replyToUserId" TEXT,
  ADD COLUMN "replyToBot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sanctionExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "evidenceEventId" TEXT;
UPDATE "ModeratorConversationMessage" SET "sentAt" = "createdAt";

ALTER TABLE "ModeratorConversationState"
  ADD COLUMN "analysisLeaseId" TEXT,
  ADD COLUMN "analysisLeaseUntil" TIMESTAMP(3);

ALTER TABLE "ModerationWarning" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'GENERAL';
UPDATE "ModerationWarning" SET "scope" = 'PROFANITY' WHERE "source" IN ('AI', 'AI_PROFANITY');
UPDATE "ModerationWarning" SET "scope" = 'CONVERSATION' WHERE "source" = 'AI_CONVERSATION';
CREATE INDEX "ModerationWarning_communityId_tgUserId_scope_createdAt_idx"
  ON "ModerationWarning"("communityId", "tgUserId", "scope", "createdAt");
-- Old event links were not unique. Preserve history instead of deleting duplicate rows.
UPDATE "ModerationWarning" AS warning SET "eventId" = NULL
WHERE warning."eventId" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "ModerationWarning" AS earlier
  WHERE earlier."eventId" = warning."eventId" AND earlier."tgUserId" = warning."tgUserId"
    AND (earlier."createdAt", earlier."id") < (warning."createdAt", warning."id")
);
CREATE UNIQUE INDEX "ModerationWarning_eventId_tgUserId_key" ON "ModerationWarning"("eventId", "tgUserId");
ALTER TABLE "ModeratorConversationMessage" ADD COLUMN "reviewedAt" TIMESTAMP(3);
