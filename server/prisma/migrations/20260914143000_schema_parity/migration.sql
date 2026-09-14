-- Align historical migrations with the Prisma schema without changing user data.
ALTER TABLE "ChannelChatLink" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "Chat" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ChatStyle" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER INDEX IF EXISTS "CommunityManagerAgentSession_communityManagerId_status_lastEven" RENAME TO "CommunityManagerAgentSession_communityManagerId_status_last_idx";
ALTER INDEX IF EXISTS "CommunityManagerDigestMessage_communityManagerId_messageThreadI" RENAME TO "CommunityManagerDigestMessage_communityManagerId_messageThr_idx";
ALTER INDEX IF EXISTS "CommunityManagerDigestMessage_communityManagerId_telegramMessag" RENAME TO "CommunityManagerDigestMessage_communityManagerId_telegramMe_key";
ALTER INDEX IF EXISTS "CommunityManagerMessage_communityManagerId_telegramMessageId_ke" RENAME TO "CommunityManagerMessage_communityManagerId_telegramMessageI_key";
ALTER INDEX IF EXISTS "CommunityManagerParticipant_communityManagerId_expertConfirmed_" RENAME TO "CommunityManagerParticipant_communityManagerId_expertConfir_idx";
ALTER INDEX IF EXISTS "CommunityManagerParticipant_communityManagerId_relationship_las" RENAME TO "CommunityManagerParticipant_communityManagerId_relationship_idx";
ALTER INDEX IF EXISTS "ScheduledModerationAction_tgChatId_telegramMessageId_actionType" RENAME TO "ScheduledModerationAction_tgChatId_telegramMessageId_action_key";
