import { randomUUID } from "node:crypto";
import type { AppStore, NewReview, NewTicket } from "../src/store/store.js";
import type {
  AdminRecord,
  AdminSessionRecord,
  DashboardCounts,
  NotificationState,
  Page,
  ReviewRecord,
  ReviewStatus,
  SupportMessageRecord,
  SupportTicketRecord,
  TicketStatus,
} from "../src/types/domain.js";

export class MemoryStore implements AppStore {
  admins: AdminRecord[] = [];
  sessions: AdminSessionRecord[] = [];
  reviews: ReviewRecord[] = [];
  tickets: SupportTicketRecord[] = [];
  notifications: Array<{ eventType: string; destination: string; status: NotificationState; error?: string }> = [];

  async createReview(input: NewReview): Promise<ReviewRecord> {
    const value: ReviewRecord = {
      id: randomUUID(),
      ...input,
      status: "pending",
      adminReply: null,
      createdAt: new Date(),
      moderatedAt: null,
      moderatedById: null,
    };
    this.reviews.push(value);
    return value;
  }

  async hasRecentDuplicateReview(ipHash: string, contentHash: string, since: Date): Promise<boolean> {
    return this.reviews.some((item) => item.ipHash === ipHash && item.contentHash === contentHash && item.createdAt >= since);
  }

  async listApprovedReviews(page: number, pageSize: number): Promise<Page<ReviewRecord>> {
    return this.reviewPage(this.reviews.filter((item) => item.status === "approved"), page, pageSize);
  }

  async listReviews(status: ReviewStatus | undefined, page: number, pageSize: number): Promise<Page<ReviewRecord>> {
    return this.reviewPage(status ? this.reviews.filter((item) => item.status === status) : this.reviews, page, pageSize);
  }

  async updateReview(id: string, input: { status: ReviewStatus; adminReply: string | null; moderatedById: string }): Promise<ReviewRecord | null> {
    const review = this.reviews.find((item) => item.id === id);
    if (!review) return null;
    review.status = input.status;
    review.adminReply = input.adminReply;
    review.moderatedById = input.moderatedById;
    review.moderatedAt = new Date();
    return review;
  }

  async createTicket(input: NewTicket): Promise<SupportTicketRecord> {
    const now = new Date();
    const ticketId = randomUUID();
    const value: SupportTicketRecord = {
      id: ticketId,
      publicNumber: input.publicNumber,
      secretTokenHash: input.secretTokenHash,
      name: input.name,
      contactType: input.contactType,
      contact: input.contact,
      category: input.category,
      subject: input.subject,
      status: "open",
      ipHash: input.ipHash,
      createdAt: now,
      updatedAt: now,
      assignedAdminId: null,
      messages: [
        { id: randomUUID(), ticketId, senderType: "user", senderAdminId: null, message: input.message, createdAt: now },
      ],
    };
    this.tickets.push(value);
    return value;
  }

  async findTicketByNumber(publicNumber: string): Promise<SupportTicketRecord | null> {
    return this.tickets.find((item) => item.publicNumber === publicNumber) ?? null;
  }

  async findTicketById(id: string): Promise<SupportTicketRecord | null> {
    return this.tickets.find((item) => item.id === id) ?? null;
  }

  async addTicketMessage(ticketId: string, sender: "user" | "admin", message: string, adminId?: string): Promise<SupportMessageRecord> {
    const ticket = this.tickets.find((item) => item.id === ticketId);
    if (!ticket) throw new Error("Ticket not found");
    const value: SupportMessageRecord = {
      id: randomUUID(),
      ticketId,
      senderType: sender,
      senderAdminId: adminId ?? null,
      message,
      createdAt: new Date(),
    };
    ticket.messages.push(value);
    ticket.status = sender === "admin" ? "waiting_user" : "in_progress";
    ticket.updatedAt = new Date();
    return value;
  }

  async listTickets(status: TicketStatus | undefined, query: string | undefined, page: number, pageSize: number): Promise<Page<SupportTicketRecord>> {
    let items = [...this.tickets];
    if (status) items = items.filter((item) => item.status === status);
    if (query) {
      const needle = query.toLowerCase();
      items = items.filter((item) => [item.publicNumber, item.name, item.subject].some((value) => value.toLowerCase().includes(needle)));
    }
    return this.ticketPage(items, page, pageSize);
  }

  async updateTicketStatus(id: string, status: TicketStatus, assignedAdminId: string): Promise<SupportTicketRecord | null> {
    const ticket = this.tickets.find((item) => item.id === id);
    if (!ticket) return null;
    ticket.status = status;
    ticket.assignedAdminId = assignedAdminId;
    ticket.updatedAt = new Date();
    return ticket;
  }

  async findAdminByUsername(username: string): Promise<AdminRecord | null> {
    return this.admins.find((item) => item.username === username) ?? null;
  }

  async createAdmin(username: string, passwordHash: string): Promise<AdminRecord> {
    const value: AdminRecord = { id: randomUUID(), username, passwordHash, active: true, createdAt: new Date() };
    this.admins.push(value);
    return value;
  }

  async createAdminSession(input: { tokenHash: string; csrfToken: string; adminId: string; expiresAt: Date }): Promise<AdminSessionRecord> {
    const admin = this.admins.find((item) => item.id === input.adminId)!;
    const value: AdminSessionRecord = { id: randomUUID(), ...input, admin };
    this.sessions.push(value);
    return value;
  }

  async findAdminSession(tokenHash: string): Promise<AdminSessionRecord | null> {
    return this.sessions.find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async touchAdminSession(): Promise<void> {}

  async deleteAdminSession(tokenHash: string): Promise<void> {
    this.sessions = this.sessions.filter((item) => item.tokenHash !== tokenHash);
  }

  async deleteExpiredAdminSessions(now: Date): Promise<void> {
    this.sessions = this.sessions.filter((item) => item.expiresAt > now);
  }

  async dashboardCounts(): Promise<DashboardCounts> {
    return {
      pendingReviews: this.reviews.filter((item) => item.status === "pending").length,
      openTickets: this.tickets.filter((item) => item.status === "open").length,
      inProgressTickets: this.tickets.filter((item) => item.status === "in_progress").length,
      totalApprovedReviews: this.reviews.filter((item) => item.status === "approved").length,
    };
  }

  async createNotificationLog(input: { eventType: string; destination: string; status: NotificationState; error?: string }): Promise<void> {
    this.notifications.push(input);
  }

  private reviewPage(items: ReviewRecord[], page: number, pageSize: number): Page<ReviewRecord> {
    const ordered = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: ordered.slice((page - 1) * pageSize, page * pageSize), total: ordered.length, page, pageSize };
  }

  private ticketPage(items: SupportTicketRecord[], page: number, pageSize: number): Page<SupportTicketRecord> {
    const ordered = [...items].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return { items: ordered.slice((page - 1) * pageSize, page * pageSize), total: ordered.length, page, pageSize };
  }
}
