-- AlterTable
ALTER TABLE "GeneratedPost" ADD COLUMN     "publishState" TEXT NOT NULL DEFAULT 'IDLE';

-- AlterTable
ALTER TABLE "ContentPlan" ADD COLUMN     "leaseOwner" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ContentPlanItem" ADD COLUMN     "contentReserved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quotaPeriod" TIMESTAMP(3),
ADD COLUMN     "visualReserved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StoredAsset" (
    "pathname" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredAsset_pkey" PRIMARY KEY ("pathname")
);

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "amountTon" DOUBLE PRECISION NOT NULL,
    "receivingWallet" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLedger" (
    "txHash" TEXT NOT NULL,
    "orderId" TEXT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLedger_pkey" PRIMARY KEY ("txHash")
);

-- CreateTable
CREATE TABLE "LegacyPaymentNotice" (
    "chargeId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyPaymentNotice_pkey" PRIMARY KEY ("chargeId")
);

-- CreateTable
CREATE TABLE "PublicationRecord" (
    "postId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "tgChatId" TEXT,
    "tgMessageId" INTEGER,
    "error" TEXT,

    CONSTRAINT "PublicationRecord_pkey" PRIMARY KEY ("postId")
);

-- CreateIndex
CREATE INDEX "StoredAsset_ownerUserId_idx" ON "StoredAsset"("ownerUserId");

-- CreateIndex
CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLedger_orderId_key" ON "PaymentLedger"("orderId");

-- CreateIndex
CREATE INDEX "PublicationRecord_userId_channelId_publishedAt_idx" ON "PublicationRecord"("userId", "channelId", "publishedAt");

-- Preserve historical TON deposits in the shared replay-protection ledger.
INSERT INTO "PaymentLedger" ("txHash", "userId", "kind", "createdAt")
SELECT CASE WHEN "txHash" ~ '^[0-9a-fA-F]{64}$' THEN lower("txHash") ELSE encode(decode(translate("txHash", '-_', '+/'), 'base64'), 'hex') END, "userId", 'legacy-subscription', "createdAt" FROM "TonPayment"
ON CONFLICT DO NOTHING;
INSERT INTO "PaymentLedger" ("txHash", "userId", "kind", "createdAt")
SELECT CASE WHEN "txHash" ~ '^[0-9a-fA-F]{64}$' THEN lower("txHash") ELSE encode(decode(translate("txHash", '-_', '+/'), 'base64'), 'hex') END, "userId", 'legacy-style', "createdAt" FROM "StylePurchase" WHERE "txHash" IS NOT NULL
ON CONFLICT DO NOTHING;
-- Recover the available history; already-purged historical posts cannot be reconstructed.
INSERT INTO "PublicationRecord" ("postId", "channelId", "userId", "status", "startedAt", "publishedAt", "tgChatId", "tgMessageId")
SELECT p.id, p."channelId", c."userId", 'PUBLISHED', COALESCE(p."publishedAt", p."createdAt"), p."publishedAt", p."tgChatId", p."tgMessageId" FROM "GeneratedPost" p JOIN "Channel" c ON c.id = p."channelId" WHERE p.status = 'PUBLISHED'
ON CONFLICT DO NOTHING;
-- Existing running plans reserved these quotas before item-level tracking existed.
UPDATE "ContentPlanItem" i SET "contentReserved" = true, "visualReserved" = p."generateVisuals", "quotaPeriod" = s."quotaResetAt"
FROM "ContentPlan" p JOIN "Channel" c ON c.id = p."channelId" JOIN "Subscription" s ON s."userId" = c."userId"
WHERE i."planId" = p.id AND p.status = 'GENERATING' AND i.status NOT IN ('DONE', 'SKIPPED');
-- A chat has a single primary publication context. Keep the most recent existing link.
WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY "chatId" ORDER BY "updatedAt" DESC, id DESC) AS n FROM "ChannelChatLink" WHERE "isPrimary")
UPDATE "ChannelChatLink" SET "isPrimary" = false WHERE id IN (SELECT id FROM ranked WHERE n > 1);
