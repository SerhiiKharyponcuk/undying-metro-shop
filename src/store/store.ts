import type {
  AdminRecord,
  AdminRole,
  AdminSessionRecord,
  AuditLogRecord,
  ContactType,
  DashboardCounts,
  EscortOrderRecord,
  EscortOrderStatus,
  EscortPenaltyListRecord,
  EscortPlayerProfileRecord,
  PenaltyAppealRecord,
  PenaltyAppealStatus,
  AdminPasskeyRecord,
  ExchangeRateSource,
  ManagerAvailabilityRecord,
  ManagerClaimResult,
  FinancialSummary,
  NotificationState,
  Page,
  ReviewRecord,
  ReviewStatus,
  SupportMessageRecord,
  SupportTicketRecord,
  TicketCategory,
  TicketStatus,
  OrderCurrency,
} from "../types/domain.js";

export interface NewReview {
  name: string;
  contact: string | null;
  rating: number;
  text: string;
  buyerGameId: string;
  reviewCodeHash: string;
  contentHash: string;
  ipHash: string;
}

export interface NewTicket {
  publicNumber: string;
  secretTokenHash: string;
  name: string;
  contactType: ContactType;
  contact: string;
  category: TicketCategory;
  subject: string;
  message: string;
  ipHash: string;
}

export type VerifiedReviewResult =
  | { status: "created"; review: ReviewRecord }
  | { status: "not_found" }
  | { status: "already_reviewed" };

export interface AdminSessionPresence {
  activeSince: Date;
  now: Date;
}

export interface NewEscortOrder {
  item: string;
  buyerName: string;
  buyerContact: string | null;
  buyerGameId: string;
  reviewCodeHash: string;
  reviewCodeIssuedAt: Date;
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
  createdById: string;
  participants: Array<{ name: string; gameId: string; contact: string | null; shareUahMinor: bigint }>;
}

export interface AppStore {
  getManagerAvailability(managerKeys: string[]): Promise<ManagerAvailabilityRecord[]>;
  claimManager(managerKey: string, now: Date, busyUntil: Date): Promise<ManagerClaimResult>;

  createVerifiedReview(input: NewReview): Promise<VerifiedReviewResult>;
  hasRecentDuplicateReview(ipHash: string, contentHash: string, since: Date): Promise<boolean>;
  listApprovedReviews(page: number, pageSize: number): Promise<Page<ReviewRecord>>;
  listReviews(status: ReviewStatus | undefined, page: number, pageSize: number): Promise<Page<ReviewRecord>>;
  updateReview(
    id: string,
    input: { status: ReviewStatus; adminReply: string | null; moderatedById: string },
  ): Promise<ReviewRecord | null>;

  createTicket(input: NewTicket): Promise<SupportTicketRecord>;
  findTicketByNumber(publicNumber: string): Promise<SupportTicketRecord | null>;
  findTicketById(id: string): Promise<SupportTicketRecord | null>;
  addTicketMessage(ticketId: string, sender: "user" | "admin", message: string, adminId?: string): Promise<SupportMessageRecord>;
  listTickets(status: TicketStatus | undefined, query: string | undefined, page: number, pageSize: number): Promise<Page<SupportTicketRecord>>;
  updateTicketStatus(id: string, status: TicketStatus, assignedAdminId: string): Promise<SupportTicketRecord | null>;

  createEscortOrder(input: NewEscortOrder): Promise<EscortOrderRecord>;
  listEscortOrders(status: EscortOrderStatus | undefined, page: number, pageSize: number): Promise<Page<EscortOrderRecord>>;
  updateEscortOrderStatus(id: string, status: EscortOrderStatus): Promise<EscortOrderRecord | null>;
  rotateEscortReviewCode(id: string, reviewCodeHash: string, issuedAt: Date): Promise<EscortOrderRecord | null>;
  updateEscortParticipantPaid(orderId: string, participantId: string, paid: boolean): Promise<EscortOrderRecord | null>;
  updateEscortParticipantAssignment(orderId: string, participantId: string, status: "invited" | "accepted" | "declined"): Promise<EscortOrderRecord | null>;
  penalizeEscortParticipant(orderId: string, participantId: string, reason: string, adminId: string): Promise<EscortOrderRecord | null>;
  listEscortPenalties(query: string | undefined, page: number, pageSize: number): Promise<Page<EscortPenaltyListRecord>>;
  deleteEscortPenalty(id: string, clearPaid?: boolean): Promise<EscortPenaltyListRecord | null>;
  replaceEscortParticipant(
    orderId: string,
    participantId: string,
    input: { name: string; gameId: string; contact: string | null },
  ): Promise<EscortOrderRecord | null>;
  listEscortPlayerProfiles(query: string | undefined, page: number, pageSize: number): Promise<Page<EscortPlayerProfileRecord>>;
  getEscortPlayerProfile(id: string): Promise<EscortPlayerProfileRecord | null>;
  findEscortPlayerProfileByGameId(gameId: string): Promise<EscortPlayerProfileRecord | null>;
  listEscortOrdersByPlayerProfile(playerProfileId: string): Promise<EscortOrderRecord[]>;
  rotateEscortPortalCode(id: string, portalCodeHash: string): Promise<EscortPlayerProfileRecord | null>;
  findBuyerOrder(gameId: string, reviewCodeHash: string): Promise<EscortOrderRecord | null>;
  createPenaltyAppeal(penaltyId: string, playerProfileId: string, message: string): Promise<PenaltyAppealRecord | null>;
  listPenaltyAppeals(status?: PenaltyAppealStatus): Promise<PenaltyAppealRecord[]>;
  updatePenaltyAppeal(id: string, input: { status: PenaltyAppealStatus; adminReply: string | null; reviewedById: string }): Promise<PenaltyAppealRecord | null>;
  getShopBankBalance(): Promise<bigint>;
  getDirectorBankBalance(): Promise<bigint>;
  getCreatorBankBalance(): Promise<bigint>;

  findAdminByUsername(username: string): Promise<AdminRecord | null>;
  listAdmins(): Promise<AdminRecord[]>;
  createAdmin(username: string, passwordHash: string, role?: AdminRole): Promise<AdminRecord>;
  updateAdmin(id: string, input: { role?: AdminRole; active?: boolean; passwordHash?: string; twoFactorSecret?: string | null; twoFactorEnabled?: boolean }): Promise<AdminRecord | null>;
  setAdminPasskeyChallenge(id: string, challenge: string | null, expiresAt: Date | null): Promise<AdminRecord | null>;
  listAdminPasskeys(adminId: string): Promise<AdminPasskeyRecord[]>;
  findAdminPasskeyByCredentialId(credentialId: string): Promise<AdminPasskeyRecord | null>;
  createAdminPasskey(input: Omit<AdminPasskeyRecord, "id" | "createdAt" | "lastUsedAt" | "admin">): Promise<AdminPasskeyRecord>;
  updateAdminPasskeyCounter(id: string, counter: bigint): Promise<void>;
  deleteAdminPasskey(id: string, adminId: string): Promise<boolean>;
  createAdminSession(input: {
    tokenHash: string;
    csrfToken: string;
    adminId: string;
    expiresAt: Date;
  }, presence: AdminSessionPresence): Promise<AdminSessionRecord>;
  refreshAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<AdminSessionRecord | null>;
  deleteAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<void>;
  deleteExpiredAdminSessions(now: Date): Promise<void>;

  createAuditLog(input: {
    adminId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void>;
  listAuditLogs(page: number, pageSize: number): Promise<Page<AuditLogRecord>>;
  financialSummary(from: Date, to: Date): Promise<FinancialSummary>;

  dashboardCounts(): Promise<DashboardCounts>;
  createNotificationLog(input: {
    eventType: string;
    destination: string;
    status: NotificationState;
    error?: string;
  }): Promise<void>;
  healthCheck(): Promise<void>;
  createBackup(): Promise<Record<string, unknown>>;
  restoreBackup(data: unknown): Promise<Record<string, number>>;
}
