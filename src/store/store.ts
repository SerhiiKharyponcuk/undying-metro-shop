import type {
  AdminRecord,
  AdminSessionRecord,
  ContactType,
  DashboardCounts,
  EscortOrderRecord,
  EscortOrderStatus,
  ExchangeRateSource,
  ManagerAvailabilityRecord,
  ManagerClaimResult,
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

export interface AdminSessionPresence {
  activeSince: Date;
  now: Date;
}

export interface NewEscortOrder {
  item: string;
  buyerName: string;
  buyerContact: string | null;
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
  participants: Array<{ name: string; contact: string | null; shareUahMinor: bigint }>;
}

export interface AppStore {
  getManagerAvailability(managerKeys: string[]): Promise<ManagerAvailabilityRecord[]>;
  claimManager(managerKey: string, now: Date, busyUntil: Date): Promise<ManagerClaimResult>;

  createReview(input: NewReview): Promise<ReviewRecord>;
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
  updateEscortParticipantPaid(orderId: string, participantId: string, paid: boolean): Promise<EscortOrderRecord | null>;
  penalizeEscortParticipant(orderId: string, participantId: string, reason: string, adminId: string): Promise<EscortOrderRecord | null>;
  replaceEscortParticipant(
    orderId: string,
    participantId: string,
    input: { name: string; contact: string | null },
  ): Promise<EscortOrderRecord | null>;
  getShopBankBalance(): Promise<bigint>;
  getDirectorBankBalance(): Promise<bigint>;
  getCreatorBankBalance(): Promise<bigint>;

  findAdminByUsername(username: string): Promise<AdminRecord | null>;
  createAdmin(username: string, passwordHash: string): Promise<AdminRecord>;
  createAdminSession(input: {
    tokenHash: string;
    csrfToken: string;
    adminId: string;
    expiresAt: Date;
  }, presence: AdminSessionPresence): Promise<AdminSessionRecord>;
  refreshAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<AdminSessionRecord | null>;
  deleteAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<void>;
  deleteExpiredAdminSessions(now: Date): Promise<void>;

  dashboardCounts(): Promise<DashboardCounts>;
  createNotificationLog(input: {
    eventType: string;
    destination: string;
    status: NotificationState;
    error?: string;
  }): Promise<void>;
}
