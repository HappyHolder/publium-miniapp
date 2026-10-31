ALTER TABLE "CollaberRequest"
ADD COLUMN "candidatePool" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "examinedIds" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "seenIds" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "pages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "pageIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pageVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "poolExhausted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "originRequestId" TEXT,
ADD COLUMN "presentationConfig" JSONB,
ADD COLUMN "deliveryBotId" TEXT;

CREATE INDEX "CollaberRequest_originRequestId_idx" ON "CollaberRequest"("originRequestId");
ALTER TABLE "CollaberRequest" ADD CONSTRAINT "CollaberRequest_originRequestId_fkey" FOREIGN KEY ("originRequestId") REFERENCES "CollaberRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CollaberExposure" (
 "id" TEXT NOT NULL,
 "communityManagerId" TEXT NOT NULL,
 "profileId" TEXT NOT NULL,
 "requestId" TEXT NOT NULL,
 "requesterId" TEXT NOT NULL,
 "public" BOOLEAN NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CollaberExposure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CollaberExposure_requestId_profileId_key" ON "CollaberExposure"("requestId", "profileId");
CREATE INDEX "CollaberExposure_communityManagerId_public_createdAt_idx" ON "CollaberExposure"("communityManagerId", "public", "createdAt");
CREATE INDEX "CollaberExposure_requesterId_createdAt_idx" ON "CollaberExposure"("requesterId", "createdAt");
ALTER TABLE "CollaberExposure" ADD CONSTRAINT "CollaberExposure_communityManagerId_fkey" FOREIGN KEY ("communityManagerId") REFERENCES "CommunityManager"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollaberExposure" ADD CONSTRAINT "CollaberExposure_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CollaberProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CollaberExposure" ADD CONSTRAINT "CollaberExposure_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CollaberRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
