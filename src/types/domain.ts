export type ReviewStatus = "pending" | "approved" | "rejected";
export type TicketStatus = "open" | "in_progress" | "waiting_user" | "closed";
export type ContactType = "telegram" | "email";
export type TicketCategory =
  | "purchase"
  | "payment"
  | "product_problem"
  | "partnership"
  | "complaint"
  | "other";
export type MessageSender = "user" | "admin";
export type NotificationState = "sent" | "failed" | "skipped";
export type OrderCurrency = "UAH" | "EUR" | "USD";
export type EscortOrderStatus = "planned" | "completed" | "paid" | "cancelled";
export type ExchangeRateSource = "uah" | "nbu" | "manual";
export type AdminAccessMode = "operator" | "observer";
export type AdminRole = "owner" | "director" | "admin" | "observer";
export type EscortAssignmentStatus = "invited" | "accepted" | "declined";
export type PenaltyAppealStatus = "pending" | "approved" | "rejected";

export interface AdminRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: AdminRole;
  active: boolean;
  twoFactorSecret: string | null;
  twoFactorEnabled: boolean;
  createdAt: Date;
  passkeyChallenge?: string | null;
  passkeyChallengeExpiresAt?: Date | null;
}

export interface AdminSessionRecord {
  id: string;
  tokenHash: string;
  csrfToken: string;
  adminId: string;
  accessMode: AdminAccessMode;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
  admin: AdminRecord;
}

export interface ReviewRecord {
  id: string;
  name: string;
  contact: string | null;
  rating: number;
  text: string;
  status: ReviewStatus;
  adminReply: string | null;
  buyerGameId: string | null;
  escortOrderId: string | null;
  contentHash: string;
  ipHash: string;
  createdAt: Date;
  moderatedAt: Date | null;
  moderatedById: string | null;
}

export interface SupportMessageRecord {
  id: string;
  ticketId: string;
  senderType: MessageSender;
  senderAdminId: string | null;
  message: string;
  createdAt: Date;
}

export interface SupportTicketRecord {
  id: string;
  publicNumber: string;
  secretTokenHash: string;
  name: string;
  contactType: ContactType;
  contact: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  ipHash: string;
  createdAt: Date;
  updatedAt: Date;
  assignedAdminId: string | null;
  messages: SupportMessageRecord[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DashboardCounts {
  pendingReviews: number;
  openTickets: number;
  inProgressTickets: number;
  totalApprovedReviews: number;
  completedEscortOrders: number;
}

export interface ManagerAvailabilityRecord {
  managerKey: string;
  busyUntil: Date;
}

export interface ManagerClaimResult {
  claimed: boolean;
  busyUntil: Date;
}

export interface EscortParticipantRecord {
  id: string;
  orderId: string;
  name: string;
  contact: string | null;
  playerProfileId: string | null;
  playerProfile: EscortPlayerProfileRecord | null;
  dailyViolationCount: number;
  shareUahMinor: bigint;
  active: boolean;
  paid: boolean;
  assignmentStatus: EscortAssignmentStatus;
  paidAt: Date | null;
  replacedAt: Date | null;
  excludedAt: Date | null;
  replacementForId: string | null;
  penalties: EscortPenaltyRecord[];
}

export interface EscortPenaltyRecord {
  id: string;
  participantId: string;
  playerProfileId: string | null;
  sequence: number;
  violationDate: Date | null;
  percentage: number;
  amountUahMinor: bigint;
  reason: string;
  createdById: string;
  createdAt: Date;
}

export interface EscortOrderRecord {
  id: string;
  item: string;
  buyerName: string;
  buyerContact: string | null;
  buyerGameId: string | null;
  reviewCodeHash: string | null;
  reviewCodeIssuedAt: Date | null;
  reviewCodeConsumedAt: Date | null;
  originalAmountMinor: bigint;
  currency: OrderCurrency;
  exchangeRateMicros: bigint;
  rateSource: ExchangeRateSource;
  amountUahMinor: bigint;
  developerAmountMinor: bigint;
  directorAmountMinor: bigint;
  creatorAmountMinor: bigint;
  escortPoolMinor: bigint;
  orderDate: Date;
  status: EscortOrderStatus;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  participants: EscortParticipantRecord[];
}

export interface EscortPlayerProfileRecord {
  id: string;
  gameId: string;
  displayName: string;
  contact: string | null;
  suspendedUntil: Date | null;
  permanentlyBanned: boolean;
  bannedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  orderCount?: number;
  penaltyCount?: number;
  earnedUahMinor?: bigint;
  withheldUahMinor?: bigint;
  paidUahMinor?: bigint;
  balanceUahMinor?: bigint;
  portalCodeHash?: string | null;
}

export interface PenaltyAppealRecord {
  id: string;
  penaltyId: string;
  playerProfileId: string;
  playerName: string;
  gameId: string;
  penaltyReason: string;
  penaltyAmountUahMinor: bigint;
  message: string;
  status: PenaltyAppealStatus;
  adminReply: string | null;
  reviewedById: string | null;
  reviewedByUsername: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

export interface AdminPasskeyRecord {
  id: string;
  adminId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: bigint;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  admin?: AdminRecord;
}

export interface AuditLogRecord {
  id: string;
  adminId: string | null;
  adminUsername: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface EscortPenaltyListRecord extends EscortPenaltyRecord {
  participantName: string;
  playerGameId: string | null;
  orderId: string;
  orderItem: string;
  buyerName: string;
  createdByUsername: string;
}

export interface FinancialSummary {
  from: Date;
  to: Date;
  orderCount: number;
  grossUahMinor: bigint;
  directorUahMinor: bigint;
  creatorUahMinor: bigint;
  escortPoolUahMinor: bigint;
  penaltiesUahMinor: bigint;
  paidToEscortsUahMinor: bigint;
  unpaidToEscortsUahMinor: bigint;
}
