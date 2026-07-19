import { randomUUID } from "node:crypto";
import type { AdminSessionPresence, AppStore, NewEscortOrder, NewReview, NewTicket, VerifiedReviewResult } from "../src/store/store.js";
import type {
  AdminRecord,
  AdminRole,
  AdminSessionRecord,
  AuditLogRecord,
  DashboardCounts,
  EscortOrderRecord,
  EscortOrderStatus,
  EscortPenaltyListRecord,
  EscortPlayerProfileRecord,
  FinancialSummary,
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
  playerProfiles: EscortPlayerProfileRecord[] = [];
  auditLogs: AuditLogRecord[] = [];
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
    const { reviewCodeHash, ...reviewInput } = input;
    const eligibleOrders = this.escortOrders
      .filter((order) => order.buyerGameId === input.buyerGameId
        && order.reviewCodeHash === reviewCodeHash
        && ["completed", "paid"].includes(order.status))
      .sort((left, right) => right.orderDate.getTime() - left.orderDate.getTime());
    if (!eligibleOrders.length) return { status: "not_found" };
    const order = eligibleOrders.find((item) => !this.reviews.some((review) => review.escortOrderId === item.id));
    if (!order) return { status: "already_reviewed" };
    const value: ReviewRecord = {
      id: randomUUID(),
      ...reviewInput,
      escortOrderId: order.id,
      status: "pending",
      adminReply: null,
      createdAt: new Date(),
      moderatedAt: null,
      moderatedById: null,
    };
    this.reviews.push(value);
    order.reviewCodeConsumedAt = new Date();
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
    const prepared = input.participants.map((participant) => {
      let profile = this.playerProfiles.find((item) => item.gameId === participant.gameId);
      if (profile?.permanentlyBanned) throw new Error(`Игрок ${participant.name} заблокирован навсегда`);
      if (profile?.suspendedUntil && profile.suspendedUntil > now) throw new Error(`Игрок ${participant.name} временно отстранён`);
      if (!profile) {
        profile = {
          id: randomUUID(), gameId: participant.gameId, displayName: participant.name, contact: participant.contact,
          suspendedUntil: null, permanentlyBanned: false, bannedAt: null, createdAt: now, updatedAt: now,
          orderCount: 0, penaltyCount: 0, earnedUahMinor: 0n, withheldUahMinor: 0n,
        };
        this.playerProfiles.push(profile);
      } else {
        profile.displayName = participant.name;
        profile.contact = participant.contact;
        profile.updatedAt = now;
      }
      return { participant, profile };
    });
    const order: EscortOrderRecord = {
      id: orderId,
      ...input,
      reviewCodeConsumedAt: null,
      status: "planned",
      createdAt: now,
      updatedAt: now,
      participants: prepared.map(({ participant, profile }) => ({
        id: randomUUID(),
        orderId,
        name: participant.name,
        contact: participant.contact,
        shareUahMinor: participant.shareUahMinor,
        playerProfileId: profile.id,
        playerProfile: profile,
        dailyViolationCount: 0,
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
    const values = status
      ? this.escortOrders.filter((order) => order.status === status)
      : this.escortOrders.filter((order) => order.status !== "cancelled");
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
    if (participant.replacedAt) throw new Error("Нельзя штрафовать заменённого игрока");
    if (participant.paid) throw new Error("Нельзя изменить уже выплаченную долю");
    const now = new Date();
    const profile = participant.playerProfile;
    if (profile?.permanentlyBanned) throw new Error("Игрок уже заблокирован навсегда");
    const sameDay = (value: Date) => value.getUTCFullYear() === now.getUTCFullYear()
      && value.getUTCMonth() === now.getUTCMonth() && value.getUTCDate() === now.getUTCDate();
    const dailyPenalties = this.escortOrders.flatMap((item) => item.participants)
      .flatMap((item) => item.penalties)
      .filter((penalty) => penalty.playerProfileId === participant.playerProfileId
        && sameDay(penalty.violationDate ?? penalty.createdAt));
    const sequence = dailyPenalties.length + 1;
    if (sequence > 5) throw new Error("Все нарушения за сегодня уже зафиксированы");
    if (!participant.active && sequence !== 5) throw new Error("Игрок уже отстранён");
    const calculated = sequence <= 4
      ? calculatePenaltyAmount(participant.shareUahMinor, sequence)
      : { percentage: 0, amountUahMinor: 0n };
    const alreadyWithheld = participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n);
    const remaining = participant.shareUahMinor - alreadyWithheld;
    participant.penalties.push({
      id: randomUUID(),
      participantId,
      playerProfileId: participant.playerProfileId,
      sequence,
      violationDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      percentage: calculated.percentage,
      amountUahMinor: calculated.amountUahMinor > remaining ? remaining : calculated.amountUahMinor,
      reason,
      createdById: adminId,
      createdAt: now,
    });
    participant.dailyViolationCount = sequence;
    if (sequence === 4) {
      participant.active = false;
      participant.excludedAt = now;
      if (profile) profile.suspendedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
    if (sequence === 5 && profile) {
      profile.permanentlyBanned = true;
      profile.bannedAt = now;
      profile.suspendedUntil = null;
      participant.active = false;
    }
    order.updatedAt = new Date();
    return order;
  }

  async replaceEscortParticipant(
    orderId: string,
    participantId: string,
    input: { name: string; gameId: string; contact: string | null },
  ): Promise<EscortOrderRecord | null> {
    const order = this.escortOrders.find((item) => item.id === orderId);
    const participant = order?.participants.find((item) => item.id === participantId);
    if (!order || !participant) return null;
    if (!participant.active && !participant.excludedAt) throw new Error("Этот игрок уже заменён");
    if (participant.replacedAt) throw new Error("Этот игрок уже заменён");
    if (participant.paid) throw new Error("Нельзя заменить игрока после выплаты");
    const withheld = participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n);
    const now = new Date();
    let profile = this.playerProfiles.find((item) => item.gameId === input.gameId);
    if (profile?.permanentlyBanned) throw new Error("Новый игрок заблокирован навсегда");
    if (profile?.suspendedUntil && profile.suspendedUntil > now) throw new Error("Новый игрок временно отстранён");
    if (!profile) {
      profile = {
        id: randomUUID(), gameId: input.gameId, displayName: input.name, contact: input.contact,
        suspendedUntil: null, permanentlyBanned: false, bannedAt: null, createdAt: now, updatedAt: now,
        orderCount: 0, penaltyCount: 0, earnedUahMinor: 0n, withheldUahMinor: 0n,
      };
      this.playerProfiles.push(profile);
    }
    participant.active = false;
    participant.replacedAt = new Date();
    order.participants.push({
      id: randomUUID(),
      orderId,
      name: input.name,
      contact: input.contact,
      playerProfileId: profile.id,
      playerProfile: profile,
      dailyViolationCount: 0,
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

  async listEscortPlayerProfiles(query: string | undefined, page: number, pageSize: number): Promise<Page<EscortPlayerProfileRecord>> {
    const needle = query?.toLowerCase();
    const values = this.playerProfiles.filter((profile) => !needle
      || [profile.gameId, profile.displayName, profile.contact ?? ""].some((value) => value.toLowerCase().includes(needle)));
    const enriched = values.map((profile) => this.enrichProfile(profile));
    return { items: enriched.slice((page - 1) * pageSize, page * pageSize), total: enriched.length, page, pageSize };
  }

  async getEscortPlayerProfile(id: string): Promise<EscortPlayerProfileRecord | null> {
    const profile = this.playerProfiles.find((item) => item.id === id);
    return profile ? this.enrichProfile(profile) : null;
  }

  async rotateEscortReviewCode(id: string, reviewCodeHash: string, issuedAt: Date): Promise<EscortOrderRecord | null> {
    const order = this.escortOrders.find((item) => item.id === id);
    if (!order) return null;
    if (order.reviewCodeConsumedAt) throw new Error("Отзыв для этого заказа уже оставлен");
    order.reviewCodeHash = reviewCodeHash;
    order.reviewCodeIssuedAt = issuedAt;
    order.updatedAt = new Date();
    return order;
  }

  async listEscortPenalties(query: string | undefined, page: number, pageSize: number): Promise<Page<EscortPenaltyListRecord>> {
    const needle = query?.toLowerCase();
    const values = this.escortOrders.flatMap((order) => order.participants.flatMap((participant) => participant.penalties.map((penalty) => ({
      ...penalty,
      participantName: participant.name,
      playerGameId: participant.playerProfile?.gameId ?? null,
      orderId: order.id,
      orderItem: order.item,
      buyerName: order.buyerName,
      createdByUsername: this.admins.find((admin) => admin.id === penalty.createdById)?.username ?? "unknown",
    })))).filter((penalty) => !needle || [
      penalty.reason,
      penalty.participantName,
      penalty.playerGameId ?? "",
      penalty.orderItem,
      penalty.buyerName,
    ].some((value) => value.toLowerCase().includes(needle)))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return { items: values.slice((page - 1) * pageSize, page * pageSize), total: values.length, page, pageSize };
  }

  async deleteEscortPenalty(id: string): Promise<EscortPenaltyListRecord | null> {
    let found: { order: EscortOrderRecord; participant: EscortOrderRecord["participants"][number]; penalty: EscortOrderRecord["participants"][number]["penalties"][number] } | null = null;
    for (const order of this.escortOrders) {
      for (const participant of order.participants) {
        const penalty = participant.penalties.find((item) => item.id === id);
        if (penalty) found = { order, participant, penalty };
      }
    }
    if (!found) return null;
    if (found.participant.paid) throw new Error("Сначала снимите отметку о выплате игроку");
    const result: EscortPenaltyListRecord = {
      ...found.penalty,
      participantName: found.participant.name,
      playerGameId: found.participant.playerProfile?.gameId ?? null,
      orderId: found.order.id,
      orderItem: found.order.item,
      buyerName: found.order.buyerName,
      createdByUsername: this.admins.find((admin) => admin.id === found!.penalty.createdById)?.username ?? "unknown",
    };
    found.participant.penalties = found.participant.penalties.filter((item) => item.id !== id);

    const targetDate = found.penalty.violationDate ?? found.penalty.createdAt;
    const dateKey = (value: Date) => value.toISOString().slice(0, 10);
    const allEntries = this.escortOrders.flatMap((order) => order.participants.flatMap((participant) => participant.penalties.map((penalty) => ({ participant, penalty }))));
    const remaining = allEntries.filter(({ participant, penalty }) => {
      const sameOwner = found!.penalty.playerProfileId
        ? penalty.playerProfileId === found!.penalty.playerProfileId
        : participant.id === found!.participant.id;
      return sameOwner && dateKey(penalty.violationDate ?? penalty.createdAt) === dateKey(targetDate);
    }).sort((left, right) => left.penalty.createdAt.getTime() - right.penalty.createdAt.getTime());
    const groupIds = new Set(remaining.map(({ penalty }) => penalty.id));
    const withheld = new Map<string, bigint>();
    for (const { participant } of remaining) {
      if (!withheld.has(participant.id)) {
        withheld.set(participant.id, participant.penalties
          .filter((penalty) => !groupIds.has(penalty.id))
          .reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n));
      }
    }
    remaining.forEach(({ participant, penalty }, index) => {
      const sequence = index + 1;
      const calculated = sequence <= 4
        ? calculatePenaltyAmount(participant.shareUahMinor, sequence)
        : { percentage: 0, amountUahMinor: 0n };
      const alreadyWithheld = withheld.get(participant.id) ?? 0n;
      const available = participant.shareUahMinor - alreadyWithheld;
      penalty.sequence = sequence;
      penalty.percentage = calculated.percentage;
      penalty.amountUahMinor = available <= 0n ? 0n : calculated.amountUahMinor > available ? available : calculated.amountUahMinor;
      withheld.set(participant.id, alreadyWithheld + penalty.amountUahMinor);
    });

    if (found.penalty.playerProfileId) {
      const profile = this.playerProfiles.find((item) => item.id === found!.penalty.playerProfileId);
      const profileEntries = allEntries.filter(({ penalty }) => penalty.playerProfileId === found!.penalty.playerProfileId);
      const groups = new Map<string, typeof profileEntries>();
      profileEntries.forEach((entry) => {
        const key = dateKey(entry.penalty.violationDate ?? entry.penalty.createdAt);
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      });
      const permanentlyBanned = [...groups.values()].some((items) => items.length >= 5);
      const now = new Date();
      const suspendedUntil = permanentlyBanned ? null : [...groups.values()]
        .filter((items) => items.length >= 4)
        .map((items) => new Date(items.sort((left, right) => left.penalty.createdAt.getTime() - right.penalty.createdAt.getTime())[3]!.penalty.createdAt.getTime() + 24 * 60 * 60 * 1000))
        .filter((value) => value > now)
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
      if (profile) {
        profile.permanentlyBanned = permanentlyBanned;
        profile.bannedAt = permanentlyBanned ? profile.bannedAt ?? now : null;
        profile.suspendedUntil = suspendedUntil;
      }
      const restricted = permanentlyBanned || Boolean(suspendedUntil);
      this.escortOrders.flatMap((order) => order.participants)
        .filter((participant) => participant.playerProfileId === found!.penalty.playerProfileId && !participant.replacedAt)
        .forEach((participant) => {
          participant.active = !restricted;
          participant.excludedAt = restricted ? now : null;
          participant.dailyViolationCount = participant.penalties.filter((penalty) => dateKey(penalty.violationDate ?? penalty.createdAt) === dateKey(now)).length;
        });
    } else {
      found.participant.active = remaining.length < 4;
      found.participant.excludedAt = remaining.length >= 4 ? found.participant.excludedAt ?? new Date() : null;
      found.participant.dailyViolationCount = remaining.length;
    }
    found.order.updatedAt = new Date();
    return result;
  }

  async getDirectorBankBalance(): Promise<bigint> {
    return this.escortOrders.filter((order) => order.status !== "cancelled").reduce((sum, order) => sum + order.directorAmountMinor, 0n);
  }

  async findAdminByUsername(username: string): Promise<AdminRecord | null> {
    return this.admins.find((item) => item.username === username) ?? null;
  }

  async listAdmins(): Promise<AdminRecord[]> {
    return [...this.admins];
  }

  async createAdmin(username: string, passwordHash: string, role: AdminRole = "admin"): Promise<AdminRecord> {
    const value: AdminRecord = { id: randomUUID(), username, passwordHash, role, active: true, createdAt: new Date() };
    this.admins.push(value);
    return value;
  }

  async updateAdmin(id: string, input: { role?: AdminRole; active?: boolean; passwordHash?: string }): Promise<AdminRecord | null> {
    const admin = this.admins.find((item) => item.id === id);
    if (!admin) return null;
    Object.assign(admin, input);
    return admin;
  }

  private reconcileAdminAccess(presence: AdminSessionPresence): void {
    for (const session of this.sessions) {
      if (
        session.accessMode === "operator"
        && (session.expiresAt <= presence.now || session.lastSeenAt < presence.activeSince || !session.admin.active || session.admin.role === "observer")
      ) {
        session.accessMode = "observer";
      }
    }
    if (this.sessions.some((item) => item.accessMode === "operator")) return;
    const candidate = this.sessions
      .filter((item) => item.expiresAt > presence.now && item.lastSeenAt >= presence.activeSince && item.admin.active && item.admin.role !== "observer")
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
      accessMode: admin.role === "observer" || this.sessions.some((item) => item.accessMode === "operator") ? "observer" : "operator",
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

  async createAuditLog(input: {
    adminId: string | null; action: string; entityType: string; entityId?: string | null; details?: Record<string, unknown>;
  }): Promise<void> {
    const admin = this.admins.find((item) => item.id === input.adminId);
    this.auditLogs.unshift({
      id: randomUUID(), adminId: input.adminId, adminUsername: admin?.username ?? null,
      action: input.action, entityType: input.entityType, entityId: input.entityId ?? null,
      details: input.details ?? null, createdAt: new Date(),
    });
  }

  async listAuditLogs(page: number, pageSize: number): Promise<Page<AuditLogRecord>> {
    return { items: this.auditLogs.slice((page - 1) * pageSize, page * pageSize), total: this.auditLogs.length, page, pageSize };
  }

  async financialSummary(from: Date, to: Date): Promise<FinancialSummary> {
    const orders = this.escortOrders.filter((order) => order.status !== "cancelled" && order.orderDate >= from && order.orderDate <= to);
    let grossUahMinor = 0n, directorUahMinor = 0n, creatorUahMinor = 0n, escortPoolUahMinor = 0n;
    let penaltiesUahMinor = 0n, paidToEscortsUahMinor = 0n, unpaidToEscortsUahMinor = 0n;
    for (const order of orders) {
      grossUahMinor += order.amountUahMinor; directorUahMinor += order.directorAmountMinor;
      creatorUahMinor += order.creatorAmountMinor; escortPoolUahMinor += order.escortPoolMinor;
      for (const participant of order.participants) {
        const withheld = participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n);
        penaltiesUahMinor += withheld;
        if (participant.replacedAt) continue;
        if (participant.paid) paidToEscortsUahMinor += participant.shareUahMinor - withheld;
        else unpaidToEscortsUahMinor += participant.shareUahMinor - withheld;
      }
    }
    return { from, to, orderCount: orders.length, grossUahMinor, directorUahMinor, creatorUahMinor, escortPoolUahMinor,
      penaltiesUahMinor, paidToEscortsUahMinor, unpaidToEscortsUahMinor };
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

  private enrichProfile(profile: EscortPlayerProfileRecord): EscortPlayerProfileRecord {
    const participants = this.escortOrders.flatMap((order) => order.participants).filter((item) => item.playerProfileId === profile.id);
    const penalties = participants.flatMap((item) => item.penalties);
    return {
      ...profile,
      orderCount: participants.length,
      penaltyCount: penalties.length,
      earnedUahMinor: participants.reduce((sum, item) => sum + item.shareUahMinor, 0n),
      withheldUahMinor: penalties.reduce((sum, item) => sum + item.amountUahMinor, 0n),
    };
  }

  private ticketPage(items: SupportTicketRecord[], page: number, pageSize: number): Page<SupportTicketRecord> {
    const ordered = [...items].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return { items: ordered.slice((page - 1) * pageSize, page * pageSize), total: ordered.length, page, pageSize };
  }
}
