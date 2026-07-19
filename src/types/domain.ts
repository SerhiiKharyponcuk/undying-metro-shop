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

export interface AdminRecord {
  id: string;
  username: string;
  passwordHash: string;
  active: boolean;
  createdAt: Date;
}

export interface AdminSessionRecord {
  id: string;
  tokenHash: string;
  csrfToken: string;
  adminId: string;
  expiresAt: Date;
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
  shareUahMinor: bigint;
  paid: boolean;
  paidAt: Date | null;
}

export interface EscortOrderRecord {
  id: string;
  item: string;
  buyerName: string;
  buyerContact: string | null;
  originalAmountMinor: bigint;
  currency: OrderCurrency;
  exchangeRateMicros: bigint;
  rateSource: ExchangeRateSource;
  amountUahMinor: bigint;
  developerAmountMinor: bigint;
  escortPoolMinor: bigint;
  orderDate: Date;
  status: EscortOrderStatus;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  participants: EscortParticipantRecord[];
}
