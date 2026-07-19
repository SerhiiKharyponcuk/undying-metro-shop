import type { PrismaClient } from "@prisma/client";
import type {
  AdminRecord,
  AdminSessionRecord,
  DashboardCounts,
  EscortOrderRecord,
  EscortOrderStatus,
  ManagerAvailabilityRecord,
  ManagerClaimResult,
  Page,
  ReviewRecord,
  ReviewStatus,
  SupportMessageRecord,
  SupportTicketRecord,
  TicketStatus,
} from "../types/domain.js";
import type { AdminSessionPresence, AppStore, NewEscortOrder, NewReview, NewTicket } from "./store.js";
import { calculatePenaltyAmount } from "../lib/escort-calculation.js";

const escortOrderInclude = {
  participants: {
    include: { penalties: { orderBy: { sequence: "asc" as const } } },
    orderBy: { createdAt: "asc" as const },
  },
};

const ACCESS_TRANSACTION_RETRIES = 3;

function isAccessTransactionConflict(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "P2002" || code === "P2034";
}

async function withAccessTransaction<T>(
  prisma: PrismaClient,
  operation: (database: any) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ACCESS_TRANSACTION_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      lastError = error;
      if (!isAccessTransactionConflict(error)) throw error;
    }
  }
  throw lastError;
}

async function reconcileAdminAccess(database: any, presence: AdminSessionPresence): Promise<void> {
  const { activeSince, now } = presence;
  await database.adminSession.updateMany({
    where: {
      accessMode: "operator",
      OR: [
        { expiresAt: { lte: now } },
        { lastSeenAt: { lt: activeSince } },
        { admin: { is: { active: false } } },
      ],
    },
    data: { accessMode: "observer" },
  });

  const operator = await database.adminSession.findFirst({
    where: {
      accessMode: "operator",
      expiresAt: { gt: now },
      lastSeenAt: { gte: activeSince },
      admin: { is: { active: true } },
    },
    select: { id: true },
  });
  if (operator) return;

  const candidate = await database.adminSession.findFirst({
    where: {
      accessMode: "observer",
      expiresAt: { gt: now },
      lastSeenAt: { gte: activeSince },
      admin: { is: { active: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (candidate) {
    await database.adminSession.update({ where: { id: candidate.id }, data: { accessMode: "operator" } });
  }
}

function mapAdmin(value: any): AdminRecord {
  return {
    id: value.id,
    username: value.username,
    passwordHash: value.passwordHash,
    active: value.active,
    createdAt: value.createdAt,
  };
}

function mapSession(value: any): AdminSessionRecord {
  return {
    id: value.id,
    tokenHash: value.tokenHash,
    csrfToken: value.csrfToken,
    adminId: value.adminId,
    accessMode: value.accessMode,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    lastSeenAt: value.lastSeenAt,
    admin: mapAdmin(value.admin),
  };
}

function mapReview(value: any): ReviewRecord {
  return {
    id: value.id,
    name: value.name,
    contact: value.contact,
    rating: value.rating,
    text: value.text,
    status: value.status,
    adminReply: value.adminReply,
    contentHash: value.contentHash,
    ipHash: value.ipHash,
    createdAt: value.createdAt,
    moderatedAt: value.moderatedAt,
    moderatedById: value.moderatedById,
  };
}

function mapMessage(value: any): SupportMessageRecord {
  return {
    id: value.id,
    ticketId: value.ticketId,
    senderType: value.senderType,
    senderAdminId: value.senderAdminId,
    message: value.message,
    createdAt: value.createdAt,
  };
}

function mapTicket(value: any): SupportTicketRecord {
  return {
    id: value.id,
    publicNumber: value.publicNumber,
    secretTokenHash: value.secretTokenHash,
    name: value.name,
    contactType: value.contactType,
    contact: value.contact,
    category: value.category,
    subject: value.subject,
    status: value.status,
    ipHash: value.ipHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    assignedAdminId: value.assignedAdminId,
    messages: (value.messages ?? []).map(mapMessage),
  };
}

function mapEscortOrder(value: any): EscortOrderRecord {
  return {
    id: value.id,
    item: value.item,
    buyerName: value.buyerName,
    buyerContact: value.buyerContact,
    originalAmountMinor: value.originalAmountMinor,
    currency: value.currency,
    exchangeRateMicros: value.exchangeRateMicros,
    rateSource: value.rateSource,
    amountUahMinor: value.amountUahMinor,
    developerAmountMinor: value.developerAmountMinor,
    directorAmountMinor: value.directorAmountMinor,
    creatorAmountMinor: value.creatorAmountMinor,
    escortPoolMinor: value.escortPoolMinor,
    orderDate: value.orderDate,
    status: value.status,
    createdById: value.createdById,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    participants: (value.participants ?? []).map((participant: any) => ({
      id: participant.id,
      orderId: participant.orderId,
      name: participant.name,
      contact: participant.contact,
      shareUahMinor: participant.shareUahMinor,
      active: participant.active,
      paid: participant.paid,
      paidAt: participant.paidAt,
      replacedAt: participant.replacedAt,
      excludedAt: participant.excludedAt,
      replacementForId: participant.replacementForId,
      penalties: (participant.penalties ?? []).map((penalty: any) => ({
        id: penalty.id,
        participantId: penalty.participantId,
        sequence: penalty.sequence,
        percentage: penalty.percentage,
        amountUahMinor: penalty.amountUahMinor,
        reason: penalty.reason,
        createdById: penalty.createdById,
        createdAt: penalty.createdAt,
      })),
    })),
  };
}

export class PrismaStore implements AppStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getManagerAvailability(managerKeys: string[]): Promise<ManagerAvailabilityRecord[]> {
    const values = await this.prisma.managerAvailability.findMany({
      where: { managerKey: { in: managerKeys } },
    });
    return values.map((value) => ({ managerKey: value.managerKey, busyUntil: value.busyUntil }));
  }

  async claimManager(managerKey: string, now: Date, busyUntil: Date): Promise<ManagerClaimResult> {
    const claimed = await this.prisma.$queryRaw<Array<{ manager_key: string; busy_until: Date }>>`
      INSERT INTO "manager_availability" ("manager_key", "busy_until", "updated_at")
      VALUES (${managerKey}, ${busyUntil}, CURRENT_TIMESTAMP)
      ON CONFLICT ("manager_key") DO UPDATE
      SET "busy_until" = EXCLUDED."busy_until", "updated_at" = CURRENT_TIMESTAMP
      WHERE "manager_availability"."busy_until" <= ${now}
      RETURNING "manager_key", "busy_until"
    `;
    if (claimed[0]) return { claimed: true, busyUntil: claimed[0].busy_until };

    const current = await this.prisma.managerAvailability.findUnique({ where: { managerKey } });
    return { claimed: false, busyUntil: current?.busyUntil ?? now };
  }

  async createReview(input: NewReview): Promise<ReviewRecord> {
    return mapReview(await this.prisma.review.create({ data: input as any }));
  }

  async hasRecentDuplicateReview(ipHash: string, contentHash: string, since: Date): Promise<boolean> {
    const result = await this.prisma.review.findFirst({ where: { ipHash, contentHash, createdAt: { gte: since } } });
    return Boolean(result);
  }

  async listApprovedReviews(page: number, pageSize: number): Promise<Page<ReviewRecord>> {
    const where = { status: "approved" as const };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.review.count({ where }),
    ]);
    return { items: items.map(mapReview), total, page, pageSize };
  }

  async listReviews(status: ReviewStatus | undefined, page: number, pageSize: number): Promise<Page<ReviewRecord>> {
    const where = status ? { status: status as any } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.review.count({ where }),
    ]);
    return { items: items.map(mapReview), total, page, pageSize };
  }

  async updateReview(
    id: string,
    input: { status: ReviewStatus; adminReply: string | null; moderatedById: string },
  ): Promise<ReviewRecord | null> {
    const existing = await this.prisma.review.findUnique({ where: { id } });
    if (!existing) return null;
    return mapReview(
      await this.prisma.review.update({
        where: { id },
        data: {
          status: input.status as any,
          adminReply: input.adminReply,
          moderatedById: input.moderatedById,
          moderatedAt: new Date(),
        },
      }),
    );
  }

  async createTicket(input: NewTicket): Promise<SupportTicketRecord> {
    const { message, ...ticket } = input;
    return mapTicket(
      await this.prisma.supportTicket.create({
        data: {
          ...(ticket as any),
          messages: { create: { senderType: "user", message } },
        },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      }),
    );
  }

  async findTicketByNumber(publicNumber: string): Promise<SupportTicketRecord | null> {
    const value = await this.prisma.supportTicket.findUnique({
      where: { publicNumber },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return value ? mapTicket(value) : null;
  }

  async findTicketById(id: string): Promise<SupportTicketRecord | null> {
    const value = await this.prisma.supportTicket.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return value ? mapTicket(value) : null;
  }

  async addTicketMessage(ticketId: string, sender: "user" | "admin", message: string, adminId?: string): Promise<SupportMessageRecord> {
    const value = await this.prisma.$transaction(async (database) => {
      const created = await database.supportMessage.create({
        data: { ticketId, senderType: sender, senderAdminId: adminId ?? null, message } as any,
      });
      await database.supportTicket.update({
        where: { id: ticketId },
        data: { status: sender === "admin" ? "waiting_user" : "in_progress" },
      });
      return created;
    });
    return mapMessage(value);
  }

  async listTickets(status: TicketStatus | undefined, query: string | undefined, page: number, pageSize: number): Promise<Page<SupportTicketRecord>> {
    const where: any = {};
    if (status) where.status = status;
    if (query) {
      where.OR = [
        { publicNumber: { contains: query, mode: "insensitive" } },
        { name: { contains: query, mode: "insensitive" } },
        { subject: { contains: query, mode: "insensitive" } },
      ];
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where,
        include: { messages: { orderBy: { createdAt: "asc" } } },
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return { items: items.map(mapTicket), total, page, pageSize };
  }

  async updateTicketStatus(id: string, status: TicketStatus, assignedAdminId: string): Promise<SupportTicketRecord | null> {
    const existing = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!existing) return null;
    return mapTicket(
      await this.prisma.supportTicket.update({
        where: { id },
        data: { status: status as any, assignedAdminId },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      }),
    );
  }

  async createEscortOrder(input: NewEscortOrder): Promise<EscortOrderRecord> {
    const { participants, ...order } = input;
    return mapEscortOrder(await this.prisma.escortOrder.create({
      data: {
        ...(order as any),
        participants: { create: participants as any },
      },
      include: escortOrderInclude,
    }));
  }

  async listEscortOrders(status: EscortOrderStatus | undefined, page: number, pageSize: number): Promise<Page<EscortOrderRecord>> {
    const where = status ? { status: status as any } : {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.escortOrder.findMany({
        where,
        include: escortOrderInclude,
        orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.escortOrder.count({ where }),
    ]);
    return { items: items.map(mapEscortOrder), total, page, pageSize };
  }

  async updateEscortOrderStatus(id: string, status: EscortOrderStatus): Promise<EscortOrderRecord | null> {
    const existing = await this.prisma.escortOrder.findUnique({ where: { id } });
    if (!existing) return null;
    return mapEscortOrder(await this.prisma.escortOrder.update({
      where: { id },
      data: { status: status as any },
      include: escortOrderInclude,
    }));
  }

  async updateEscortParticipantPaid(orderId: string, participantId: string, paid: boolean): Promise<EscortOrderRecord | null> {
    const participant = await this.prisma.escortParticipant.findFirst({ where: { id: participantId, orderId } });
    if (!participant) return null;
    if (participant.replacedAt) throw new Error("Нельзя выплатить долю заменённому игроку");
    await this.prisma.escortParticipant.update({
      where: { id: participantId },
      data: { paid, paidAt: paid ? new Date() : null },
    });
    const order = await this.prisma.escortOrder.findUnique({
      where: { id: orderId },
      include: escortOrderInclude,
    });
    return order ? mapEscortOrder(order) : null;
  }

  async penalizeEscortParticipant(orderId: string, participantId: string, reason: string, adminId: string): Promise<EscortOrderRecord | null> {
    const order = await this.prisma.$transaction(async (database) => {
      const participant = await database.escortParticipant.findFirst({
        where: { id: participantId, orderId },
        include: { penalties: { orderBy: { sequence: "asc" } } },
      });
      if (!participant) return null;
      if (!participant.active) throw new Error(participant.excludedAt ? "Игрок уже исключён после четвёртого нарушения" : "Нельзя штрафовать заменённого игрока");
      if (participant.paid) throw new Error("Нельзя изменить уже выплаченную долю");
      const sequence = participant.penalties.length + 1;
      const penalty = calculatePenaltyAmount(participant.shareUahMinor, sequence);
      const alreadyWithheld = participant.penalties.reduce((sum, item) => sum + item.amountUahMinor, 0n);
      const remaining = participant.shareUahMinor - alreadyWithheld;
      const amountUahMinor = penalty.amountUahMinor > remaining ? remaining : penalty.amountUahMinor;
      await database.escortPenalty.create({
        data: { participantId, sequence, percentage: penalty.percentage, amountUahMinor, reason, createdById: adminId },
      });
      if (sequence === 4) {
        await database.escortParticipant.update({
          where: { id: participantId },
          data: { active: false, excludedAt: new Date() },
        });
      }
      return database.escortOrder.findUnique({ where: { id: orderId }, include: escortOrderInclude });
    }, { isolationLevel: "Serializable" });
    return order ? mapEscortOrder(order) : null;
  }

  async replaceEscortParticipant(
    orderId: string,
    participantId: string,
    input: { name: string; contact: string | null },
  ): Promise<EscortOrderRecord | null> {
    const order = await this.prisma.$transaction(async (database) => {
      const participant = await database.escortParticipant.findFirst({
        where: { id: participantId, orderId },
        include: { penalties: true },
      });
      if (!participant) return null;
      if (!participant.active && !participant.excludedAt) throw new Error("Этот игрок уже заменён");
      if (participant.replacedAt) throw new Error("Этот игрок уже заменён");
      if (participant.paid) throw new Error("Нельзя заменить игрока после выплаты");
      const withheld = participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n);
      const transferredShare = participant.shareUahMinor - withheld;
      if (transferredShare <= 0n) throw new Error("У игрока не осталось доли для передачи");
      await database.escortParticipant.update({
        where: { id: participantId },
        data: { active: false, replacedAt: new Date() },
      });
      await database.escortParticipant.create({
        data: {
          orderId,
          name: input.name,
          contact: input.contact,
          shareUahMinor: transferredShare,
          replacementForId: participantId,
        },
      });
      return database.escortOrder.findUnique({ where: { id: orderId }, include: escortOrderInclude });
    }, { isolationLevel: "Serializable" });
    return order ? mapEscortOrder(order) : null;
  }

  async getShopBankBalance(): Promise<bigint> {
    const result = await this.prisma.escortPenalty.aggregate({ _sum: { amountUahMinor: true } });
    return result._sum.amountUahMinor ?? 0n;
  }

  async getCreatorBankBalance(): Promise<bigint> {
    const result = await this.prisma.escortOrder.aggregate({
      where: { status: { not: "cancelled" } },
      _sum: { creatorAmountMinor: true },
    });
    return result._sum.creatorAmountMinor ?? 0n;
  }

  async getDirectorBankBalance(): Promise<bigint> {
    const result = await this.prisma.escortOrder.aggregate({
      where: { status: { not: "cancelled" } },
      _sum: { directorAmountMinor: true },
    });
    return result._sum.directorAmountMinor ?? 0n;
  }

  async findAdminByUsername(username: string): Promise<AdminRecord | null> {
    const value = await this.prisma.admin.findUnique({ where: { username } });
    return value ? mapAdmin(value) : null;
  }

  async createAdmin(username: string, passwordHash: string): Promise<AdminRecord> {
    return mapAdmin(await this.prisma.admin.create({ data: { username, passwordHash } }));
  }

  async createAdminSession(
    input: { tokenHash: string; csrfToken: string; adminId: string; expiresAt: Date },
    presence: AdminSessionPresence,
  ): Promise<AdminSessionRecord> {
    const value = await withAccessTransaction(this.prisma, async (database) => {
      await database.adminSession.deleteMany({ where: { expiresAt: { lte: presence.now } } });
      await reconcileAdminAccess(database, presence);
      const operator = await database.adminSession.findFirst({ where: { accessMode: "operator" }, select: { id: true } });
      return database.adminSession.create({
        data: {
          ...input,
          accessMode: operator ? "observer" : "operator",
          lastSeenAt: presence.now,
        },
        include: { admin: true },
      });
    });
    return mapSession(value);
  }

  async refreshAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<AdminSessionRecord | null> {
    const value = await withAccessTransaction(this.prisma, async (database) => {
      const session = await database.adminSession.findUnique({ where: { tokenHash }, include: { admin: true } });
      if (!session || !session.admin.active || session.expiresAt <= presence.now) {
        if (session) await database.adminSession.delete({ where: { id: session.id } });
        await reconcileAdminAccess(database, presence);
        return null;
      }
      await database.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: presence.now } });
      await reconcileAdminAccess(database, presence);
      return database.adminSession.findUnique({ where: { id: session.id }, include: { admin: true } });
    });
    return value ? mapSession(value) : null;
  }

  async deleteAdminSession(tokenHash: string, presence: AdminSessionPresence): Promise<void> {
    await withAccessTransaction(this.prisma, async (database) => {
      await database.adminSession.deleteMany({ where: { tokenHash } });
      await reconcileAdminAccess(database, presence);
    });
  }

  async deleteExpiredAdminSessions(now: Date): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { expiresAt: { lte: now } } });
  }

  async dashboardCounts(): Promise<DashboardCounts> {
    const [pendingReviews, openTickets, inProgressTickets, totalApprovedReviews] = await this.prisma.$transaction([
      this.prisma.review.count({ where: { status: "pending" } }),
      this.prisma.supportTicket.count({ where: { status: "open" } }),
      this.prisma.supportTicket.count({ where: { status: "in_progress" } }),
      this.prisma.review.count({ where: { status: "approved" } }),
    ]);
    return { pendingReviews, openTickets, inProgressTickets, totalApprovedReviews };
  }

  async createNotificationLog(input: { eventType: string; destination: string; status: "sent" | "failed" | "skipped"; error?: string }): Promise<void> {
    await this.prisma.notificationLog.create({ data: input as any });
  }
}
