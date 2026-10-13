export type AxisKey = 'activity' | 'engagement' | 'climate' | 'growth' | 'core'
export interface PulseReport {
  period: { from: string; to: string; days: number; daysWithData: number; observedDays: number }
  score: number | null
  scoreDelta: number | null
  axes: Record<AxisKey, number | null>
  model: {
    version: string; status: 'complete' | 'preliminary' | 'insufficient'; scoredDays: number
    scoredFrom: string | null; scoredTo: string; availableAxes: AxisKey[]; bounds: number[]
    comparisonReason: string; population: string; coverageNote: string
    deltaContributions: Record<AxisKey, number> | null
    details: Record<AxisKey, { formula: string; reason: string; preliminary: boolean; metrics: {
      label: string; value: number | null; unit: string; numerator?: number; denominator?: number; score?: number | null; explanation: string
    }[] }>
  }
  scoreSeries: { day: string; value: number | null }[]
  headline: {
    memberCount: number | null; memberCountAt: string | null; dau: number | null; mau: number; stickiness: number | null
    activeRate: number | null; messages: number; messagesPerDay: number | null; replyShare: number | null
    joins: number | null; leaves: number | null; netGrowth: number | null; churnRate: number | null
    newSpeakers: number | null; speakerConversion: number | null; newcomerCount: number | null; concentration: number | null
  }
  quality: { fullObserved: boolean; membershipComplete: boolean; legacy: boolean; estimatedFacts: number; knownTenure: number; unknownTenure: number | null; moderationFrom: string | null }
  moderation: {
    blockedMessages: number; pendingDeletions: number; unconfirmedDeletions: number; culturalRewrites: number; interventions: number; sanctionedResponses: number
    conflicts: number; harassment: number; affectedUsers: number; resolvedEpisodes: number; escalatedEpisodes: number
    temporaryRisks: { tgUserId: string; label: string; score: number; level: string; evidenceCount: number; lastEventAt: string; evidence: { category: string; severity: string; text: string; at: string }[] }[]
  }
  series: { day: string; observed: boolean; messages: number | null; activeUsers: number | null; joins: number | null; leaves: number | null }[]
  heatmap: number[][]
  orbit: { tier: string; count: number; share: number }[]
  topParticipants: { tgUserId: string; username: string | null; displayName: string | null; messages: number; activeDays: number; share: number }[]
  cohorts: { cohort: string; size: number; retention: (number | null)[]; counts: (number | null)[] }[]
  tenure: { bucket: string; count: number }[]
}
