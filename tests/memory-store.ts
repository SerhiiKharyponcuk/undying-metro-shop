import { randomUUID } from "node:crypto";
import type { AdminSessionPresence, AppStore, NewEscortOrder, NewReview, NewTicket, VerifiedReviewResult } from "../src/store/store.js";
import type {
  AdminRecord,
  AdminSessionRecord,
  DashboardCounts,
  EscortOrderRecord,
  EscortOrderStatus,
  ManagerAvailabilityRecord,
  ManagerClaimResult,
  NotificationState,
  Page,
  ReviewRecord,
  ReviewStatus,
  SupportMessageRecord,
  SupportTicketRecord,
  TicketStatus,
} from "../src/types/domain.js";
import { calculatePenaltyAmount } from "../src/lib/escort-calculation.js";

export class MemoryStore implements AppStore {
  admins: AdminRecord[] = [];
  sessions: AdminSessionRecord[] = [];
  reviews: ReviewRecord[] = [];
  tickets: SupportTicketRecord[] = [];
  escortOrders: EscortOrderRecord[] = [];
  notifications: Array<{ eventType: string; destination: string; status: NotificationState; error?: string }> = [];
  managerAvailability = new Map<string, Date>();

  async getManagerAvailability(managerKeys: string[]): Promise<ManagerAvailabilityRecord[]> {
    return managerKeys.flatMap((managerKey) => {
      const busyUntil = this.managerAvailability.get(managerKey);
      return busyUntil ? [{ managerKey, busyUntil }] : [];
    });
  }

  async claimManager(managerKey: string, now: Date, busyUntil: Date): Promise<ManagerClaimResult> {
    const current = this.managerAvailability.get(managerKey);
    if (current && current > now) return { claimed: false, busyUntil: current };
    this.managerAvailability.set(managerKey, busyUntil);
    return { claimed: true, busyUntil };
  }

  async createVerifiedReview(input: NewReview): Promise<VerifiedReviewResult> {
    const eligibleOrders = this.escortOrders
      .filter((order) => order.buyerGameId === input.buyerGameId && ["completed", "paid"].includes(order.status))
      .sort((left, right) => right.orderDate.getTime() - left.orderDate.getTime());
    if (!eligibleOrders.length) return { status: "not_found" };
    const order = eligibleOrders.find((item) => !this.reviews.some((review) => review.escortOrderId === item.id));
    if (!order) return { status: "already_reviewed" };
    const value: ReviewRecord = {
      id: randomUUID(),
      ...input,
      escortOrderId: order.id,
      status: "pending",
      adminReply: null,
      createdAt: new Date(),
      moderatedAt: null,
      moderatedById: null,
    };
    this.reviews.push(value);
    return { status: "created", review: value };
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

  async createEscortOrder(input: NewEscortOrder): Promise<EscortOrderRecord> {
    const now = new Date();
    const orderId = randomUUID();
    const order: EscortOrderRecord = {
      id: orderId,
      ...input,
      status: "planned",
      createdAt: now,
      updatedAt: now,
      participants: input.participants.map((participant) => ({
        id: randomUUID(),
        orderId,
        ...participant,
        active: true,
        paid: false,
        paidAt: null,
        replacedAt: null,
        excludedAt: null,
        replacementForId: null,
        penalties: [],
      })),
    };
    this.escortOrders.push(order);
    return order;
  }

  async listEscortOrders(status: EscortOrderStatus | undefined, page: number, pageSize: number): Promise<Page<EscortOrderRecord>> {
    const values = status ? this.escortOrders.filter((order) => order.status === status) : this.escortOrders;
    const ordered = [...values].sort((a, b) => b.orderDate.getTime() - a.orderDate.getTime());
    return { items: ordered.slice((page - 1) * pageSize, page * pageSize), total: ordered.length, page, pageSize };
  }

  async updateEscortOrderStatus(id: string, status: EscortOrderStatus): Promise<EscortOrderRecord | null> {
    const order = this.escortOrders.find((item) => item.id === id);
    if (!order) return null;
    order.status = status;
    order.updatedAt = new Date();
    return order;
  }

  async updateEscortParticipantPaid(orderId: string, participantId: string, paid: boolean): Promise<EscortOrderRecord | null> {
    const order = this.escortOrders.find((item) => item.id === orderId);
    const participant = order?.participants.find((item) => item.id === participantId);
    if (!order || !participant) return null;
    if (participant.replacedAt) throw new Error("Нельзя выплатить долю заменённому игроку");
    participant.paid = paid;
    participant.paidAt = paid ? new Date() : null;
    order.updatedAt = new Date();
    return order;
  }

  async penalizeEscortParticipant(orderId: string, participantId: string, reason: string, adminId: string): Promise<EscortOrderRecord | null> {
    const order = this.escortOrders.find((item) => item.id === orderId);
    const participant = order?.participants.find((item) => item.id === participantId);
    if (!order || !participant) return null;
    if (!participant.active) throw new Error(participant.excludedAt ? "Игрок уже исключён после четвёртого нарушения" : "Нельзя штрафовать заменённого игрока");
    if (participant.paid) throw new Error("Нельзя изменить уже выплаченную долю");
    const sequence = participant.penalties.length + 1;
    const calculated = calculatePenaltyAmount(participant.shareUahMinor, sequence);
    participant.penalties.push({
      id: randomUUID(),
      participantId,
      sequence,
      percentage: calculated.percentage,
      amountUahMinor: calculated.amountUahMinor,
      reason,
      createdById: adminId,
      createdAt: new Date(),
    });
    if (sequence === 4) {
      participant.active = false;
      participant.excludedAt = new Date();
    }
    order.updatedAt = new Date();
    return order;
  }

  async replaceEscortParticipant(
    orderId: string,
    participantId: string,
    input: { name: string; contact: string | null },
  ): Promise<EscortOrderRecord | null> {
    const order = this.escortOrders.find((item) => item.id === orderId);
    const participant = order?.participants.find((item) => item.id === participantId);
    if (!order || !participant) return null;
    if (!participant.active && !participant.excludedAt) throw new Error("Этот игрок уже заменён");
    if (participant.replacedAt) throw new Error("Этот игрок уже заменён");
    if (participant.paid) throw new Error("Нельзя заменить игрока после выплаты");
    const withheld = participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n);
    participant.active = false;
    participant.replacedAt = new Date();
    order.participants.push({
      id: randomUUID(),
      orderId,
      name: input.name,
      contact: input.contact,
      shareUahMinor: participant.shareUahMinor - withheld,
      active: true,
      paid: false,
      paidAt: null,
      replacedAt: null,
      excludedAt: null,
      replacementForId: participant.id,
      penalties: [],
    });
    order.updatedAt = new Date();
    return order;
  }

  async getShopBankBalance(): Promise<bigint> {
    return this.escortOrders.reduce(
      (orders, order) => orders + order.participants.reduce(
        (participants, participant) => participants + participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n),
        0n,
      ),
      0n,
    );
  }

  async getCreatorBankBalance(): Promise<bigint> {
    return this.escortOrders.filter((order) => order.status !== "cancelled").reduce((sum, order) => sum + order.creatorAmountMinor, 0n);
  }

  async getDirectorBankBalance(): Promise<bigint> {
    return this.escortOrders.filter((order) => order.status !== "cancelled").reduce((sum, order) => sum + order.directorAmountMinor, 0n);
  }

  async findAdminByUsername(username: string): Promise<AdminRecord | null> {
    return this.admins.find((item) => item.username === username) ?? null;
  }

  async createAdmin(username: string, passwordHash: string): Promise<AdminRecord> {
    const value: AdminRecord = { id: randomUUID(), username, passwordHash, active: true, createdAt: new Date() };
    this.admins.push(value);
    return value;
  }

  private reconcileAdminAccess(presence: AdminSessionPresence): void {
    for (const session of this.sessions) {
      if (
        session.accessMode === "operator"
        && (session.expiresAt <= presence.now || session.lastSeenAt < presence.activeSince || !session.admin.active)
      ) {
        session.accessMode = "observer";
      }
    }
    if (this.sessions.some((item) => item.accessMode === "operator")) return;
    const candidate = this.sessions
      .filter((item) => item.expiresAt > presence.now && item.lastSeenAt >= presence.activeSince && item.admin.active)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))[0];
    if (candidate) candidate.accessMode = "operator";
  }

  async createAdminSession(
    input: { tokenHash: string; csrfToken: string; adminId: string; expiresAt: Date },
    presence: AdminSessionPresence,
  ): Promise<AdminSessionRecord> {
    this.sessions = this.sessions.filter((item) => item.expiresAt > presence.now);
    this.reconcileAdminAccess(presence);
    const admin = this.admins.find((item) => item.id === input.adminId)!;
    const value: AdminSessionRecord = {
      id: randomUUID(),
      ...input,
      accessMode: this.sessions.some((item) => item.accessMode === "operator") ? "observer" : "operator",
      createdAt: presence.now,
      lastSeenAt: presence.now,
      admin,
    };
    this.sessions.push(value);
    return value;
  }

  async refreshAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<AdminSessionRecord | null> {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || !session.admin.active || session.expiresAt <= presence.now) {
      if (session) this.sessions = this.sessions.filter((item) => item.id !== session.id);
      this.reconcileAdminAccess(presence);
      return null;
    }
    session.lastSeenAt = presence.now;
    this.reconcileAdminAccess(presence);
    return session;
  }

  async deleteAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<void> {
    this.sessions = this.sessions.filter((item) => item.tokenHash !== tokenHash);
    this.reconcileAdminAccess(presence);
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
      completedEscortOrders: this.escortOrders.filter((item) => ["completed", "paid"].includes(item.status)).length,
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
