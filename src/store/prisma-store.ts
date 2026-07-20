import type { PrismaClient } from "@prisma/client";
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
  Page,
  ReviewRecord,
  ReviewStatus,
  SupportMessageRecord,
  SupportTicketRecord,
  TicketStatus,
  PenaltyAppealRecord,
  PenaltyAppealStatus,
  AdminPasskeyRecord,
} from "../types/domain.js";
import type { AdminSessionPresence, AppStore, NewEscortOrder, NewReview, NewTicket, VerifiedReviewResult } from "./store.js";
import { calculatePenaltyAmount } from "../lib/escort-calculation.js";

const escortOrderInclude = {
  participants: {
    include: {
      penalties: { orderBy: [{ violationDate: "asc" as const }, { sequence: "asc" as const }] },
      playerProfile: { include: { penalties: { select: { violationDate: true } } } },
    },
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
        { admin: { is: { OR: [{ active: false }, { role: "observer" }] } } },
      ],
    },
    data: { accessMode: "observer" },
  });

  const operator = await database.adminSession.findFirst({
    where: {
      accessMode: "operator",
      expiresAt: { gt: now },
      lastSeenAt: { gte: activeSince },
      admin: { is: { active: true, role: { not: "observer" } } },
    },
    select: { id: true },
  });
  if (operator) return;

  const candidate = await database.adminSession.findFirst({
    where: {
      accessMode: "observer",
      expiresAt: { gt: now },
      lastSeenAt: { gte: activeSince },
      admin: { is: { active: true, role: { not: "observer" } } },
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
    role: value.role,
    active: value.active,
    twoFactorSecret: value.twoFactorSecret ?? null,
    twoFactorEnabled: value.twoFactorEnabled ?? false,
    createdAt: value.createdAt,
    passkeyChallenge: value.passkeyChallenge ?? null,
    passkeyChallengeExpiresAt: value.passkeyChallengeExpiresAt ?? null,
  };
}

function mapPlayerProfile(value: any): EscortPlayerProfileRecord {
  return {
    id: value.id,
    gameId: value.gameId,
    displayName: value.displayName,
    contact: value.contact,
    suspendedUntil: value.suspendedUntil,
    permanentlyBanned: value.permanentlyBanned,
    bannedAt: value.bannedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    orderCount: value._count?.participants,
    penaltyCount: value._count?.penalties,
    earnedUahMinor: value.earnedUahMinor,
    withheldUahMinor: value.withheldUahMinor,
    paidUahMinor: value.paidUahMinor,
    balanceUahMinor: value.balanceUahMinor,
    portalCodeHash: value.portalCodeHash ?? null,
  };
}

function mapAppeal(value: any): PenaltyAppealRecord {
  return {
    id: value.id,
    penaltyId: value.penaltyId,
    playerProfileId: value.playerProfileId,
    playerName: value.playerProfile.displayName,
    gameId: value.playerProfile.gameId,
    penaltyReason: value.penalty.reason,
    penaltyAmountUahMinor: value.penalty.amountUahMinor,
    message: value.message,
    status: value.status,
    adminReply: value.adminReply,
    reviewedById: value.reviewedById,
    reviewedByUsername: value.reviewedBy?.username ?? null,
    createdAt: value.createdAt,
    reviewedAt: value.reviewedAt,
  };
}

function mapPasskey(value: any): AdminPasskeyRecord {
  return {
    id: value.id,
    adminId: value.adminId,
    credentialId: value.credentialId,
    publicKey: new Uint8Array(value.publicKey),
    counter: value.counter,
    transports: value.transports ?? [],
    deviceType: value.deviceType,
    backedUp: value.backedUp,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt,
    admin: value.admin ? mapAdmin(value.admin) : undefined,
  };
}

function mapPenaltyList(value: any): EscortPenaltyListRecord {
  return {
    id: value.id,
    participantId: value.participantId,
    playerProfileId: value.playerProfileId,
    sequence: value.sequence,
    violationDate: value.violationDate,
    percentage: value.percentage,
    amountUahMinor: value.amountUahMinor,
    reason: value.reason,
    createdById: value.createdById,
    createdAt: value.createdAt,
    participantName: value.participant.name,
    playerGameId: value.participant.playerProfile?.gameId ?? null,
    orderId: value.participant.order.id,
    orderItem: value.participant.order.item,
    buyerName: value.participant.order.buyerName,
    createdByUsername: value.createdBy.username,
  };
}

function isSameUtcDay(value: Date | null | undefined, now = new Date()): boolean {
  return Boolean(value)
    && value!.getUTCFullYear() === now.getUTCFullYear()
    && value!.getUTCMonth() === now.getUTCMonth()
    && value!.getUTCDate() === now.getUTCDate();
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
    buyerGameId: value.buyerGameId,
    escortOrderId: value.escortOrderId,
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
    buyerGameId: value.buyerGameId,
    reviewCodeHash: value.reviewCodeHash,
    reviewCodeIssuedAt: value.reviewCodeIssuedAt,
    reviewCodeConsumedAt: value.reviewCodeConsumedAt,
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
      playerProfileId: participant.playerProfileId,
      playerProfile: participant.playerProfile ? mapPlayerProfile(participant.playerProfile) : null,
      dailyViolationCount: participant.playerProfile
        ? (participant.playerProfile.penalties ?? []).filter((penalty: any) => isSameUtcDay(penalty.violationDate)).length
        : (participant.penalties ?? []).filter((penalty: any) => isSameUtcDay(penalty.violationDate ?? penalty.createdAt)).length,
      shareUahMinor: participant.shareUahMinor,
      active: participant.active,
      paid: participant.paid,
      assignmentStatus: participant.assignmentStatus,
      paidAt: participant.paidAt,
      replacedAt: participant.replacedAt,
      excludedAt: participant.excludedAt,
      replacementForId: participant.replacementForId,
      penalties: (participant.penalties ?? []).map((penalty: any) => ({
        id: penalty.id,
        participantId: penalty.participantId,
        playerProfileId: penalty.playerProfileId,
        sequence: penalty.sequence,
        violationDate: penalty.violationDate,
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

  async createVerifiedReview(input: NewReview): Promise<VerifiedReviewResult> {
    try {
      return await this.prisma.$transaction(async (database) => {
        const { reviewCodeHash, ...reviewInput } = input;
        const eligibleWhere = {
          buyerGameId: input.buyerGameId,
          reviewCodeHash,
          status: { in: ["completed", "paid"] as EscortOrderStatus[] },
        };
        const eligible = await database.escortOrder.findFirst({ where: eligibleWhere, select: { id: true } });
        if (!eligible) return { status: "not_found" as const };

        const available = await database.escortOrder.findFirst({
          where: { ...eligibleWhere, review: { is: null } },
          orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
          select: { id: true },
        });
        if (!available) return { status: "already_reviewed" as const };

        const review = await database.review.create({
          data: { ...reviewInput, escortOrderId: available.id },
        });
        await database.escortOrder.update({
          where: { id: available.id },
          data: { reviewCodeConsumedAt: new Date() },
        });
        return { status: "created" as const, review: mapReview(review) };
      });
    } catch (error) {
      if ((error as { code?: unknown })?.code === "P2002") return { status: "already_reviewed" };
      throw error;
    }
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
    const created = await this.prisma.$transaction(async (database) => {
      const now = new Date();
      const prepared = [];
      for (const participant of participants) {
        const existing = await database.escortPlayerProfile.findUnique({ where: { gameId: participant.gameId } });
        if (existing?.permanentlyBanned) throw new Error(`Игрок ${participant.name} заблокирован навсегда`);
        if (existing?.suspendedUntil && existing.suspendedUntil > now) {
          throw new Error(`Игрок ${participant.name} отстранён до ${existing.suspendedUntil.toISOString()}`);
        }
        const profile = await database.escortPlayerProfile.upsert({
          where: { gameId: participant.gameId },
          create: { gameId: participant.gameId, displayName: participant.name, contact: participant.contact },
          update: { displayName: participant.name, contact: participant.contact },
        });
        prepared.push({
          name: participant.name,
          contact: participant.contact,
          shareUahMinor: participant.shareUahMinor,
          playerProfileId: profile.id,
        });
      }
      return database.escortOrder.create({
        data: { ...(order as any), participants: { create: prepared } },
        include: escortOrderInclude,
      });
    }, { isolationLevel: "Serializable" });
    return mapEscortOrder(created);
  }

  async listEscortOrders(status: EscortOrderStatus | undefined, page: number, pageSize: number): Promise<Page<EscortOrderRecord>> {
    const where = status ? { status: status as any } : { status: { not: "cancelled" as const } };
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
      const now = new Date();
      const violationDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const nextDate = new Date(violationDate.getTime() + 24 * 60 * 60 * 1000);
      const participant = await database.escortParticipant.findFirst({
        where: { id: participantId, orderId },
        include: { penalties: { orderBy: { createdAt: "asc" } }, playerProfile: true },
      });
      if (!participant) return null;
      if (participant.replacedAt) throw new Error("Нельзя штрафовать заменённого игрока");
      if (participant.paid) throw new Error("Нельзя изменить уже выплаченную долю");
      if (participant.playerProfile?.permanentlyBanned) throw new Error("Игрок уже заблокирован навсегда");
      const dailyCount = participant.playerProfileId
        ? await database.escortPenalty.count({
            where: { playerProfileId: participant.playerProfileId, violationDate: { gte: violationDate, lt: nextDate } },
          })
        : participant.penalties.filter((item: any) => {
            const value = item.violationDate ?? item.createdAt;
            return value >= violationDate && value < nextDate;
          }).length;
      const sequence = dailyCount + 1;
      if (sequence > 5) throw new Error("Все нарушения за сегодня уже зафиксированы");
      if (!participant.active && sequence !== 5) throw new Error("Игрок уже отстранён");
      const penalty = sequence <= 4
        ? calculatePenaltyAmount(participant.shareUahMinor, sequence)
        : { percentage: 0, amountUahMinor: 0n };
      const alreadyWithheld = participant.penalties.reduce((sum, item) => sum + item.amountUahMinor, 0n);
      const remaining = participant.shareUahMinor - alreadyWithheld;
      const amountUahMinor = penalty.amountUahMinor > remaining ? remaining : penalty.amountUahMinor;
      await database.escortPenalty.create({
        data: {
          participantId,
          playerProfileId: participant.playerProfileId,
          violationDate,
          sequence,
          percentage: penalty.percentage,
          amountUahMinor,
          reason,
          createdById: adminId,
        },
      });
      if (sequence === 4) {
        const suspendedUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        await database.escortParticipant.update({
          where: { id: participantId },
          data: { active: false, excludedAt: now },
        });
        if (participant.playerProfileId) {
          await database.escortPlayerProfile.update({
            where: { id: participant.playerProfileId },
            data: { suspendedUntil },
          });
        }
      }
      if (sequence === 5 && participant.playerProfileId) {
        await database.escortPlayerProfile.update({
          where: { id: participant.playerProfileId },
          data: { permanentlyBanned: true, bannedAt: now, suspendedUntil: null },
        });
        await database.escortParticipant.update({
          where: { id: participantId },
          data: { active: false, excludedAt: participant.excludedAt ?? now },
        });
      }
      return database.escortOrder.findUnique({ where: { id: orderId }, include: escortOrderInclude });
    }, { isolationLevel: "Serializable" });
    return order ? mapEscortOrder(order) : null;
  }

  async replaceEscortParticipant(
    orderId: string,
    participantId: string,
    input: { name: string; gameId: string; contact: string | null },
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
      const now = new Date();
      const existingProfile = await database.escortPlayerProfile.findUnique({ where: { gameId: input.gameId } });
      if (existingProfile?.permanentlyBanned) throw new Error("Новый игрок заблокирован навсегда");
      if (existingProfile?.suspendedUntil && existingProfile.suspendedUntil > now) {
        throw new Error(`Новый игрок отстранён до ${existingProfile.suspendedUntil.toISOString()}`);
      }
      const profile = await database.escortPlayerProfile.upsert({
        where: { gameId: input.gameId },
        create: { gameId: input.gameId, displayName: input.name, contact: input.contact },
        update: { displayName: input.name, contact: input.contact },
      });
      await database.escortParticipant.update({
        where: { id: participantId },
        data: { active: false, replacedAt: new Date() },
      });
      await database.escortParticipant.create({
        data: {
          orderId,
          name: input.name,
          contact: input.contact,
          playerProfileId: profile.id,
          shareUahMinor: transferredShare,
          replacementForId: participantId,
        },
      });
      return database.escortOrder.findUnique({ where: { id: orderId }, include: escortOrderInclude });
    }, { isolationLevel: "Serializable" });
    return order ? mapEscortOrder(order) : null;
  }

  async updateEscortParticipantAssignment(orderId: string, participantId: string, status: "invited" | "accepted" | "declined"): Promise<EscortOrderRecord | null> {
    const participant = await this.prisma.escortParticipant.findFirst({ where: { id: participantId, orderId } });
    if (!participant) return null;
    await this.prisma.escortParticipant.update({ where: { id: participantId }, data: { assignmentStatus: status } });
    const order = await this.prisma.escortOrder.findUnique({ where: { id: orderId }, include: escortOrderInclude });
    return order ? mapEscortOrder(order) : null;
  }

  async listEscortPenalties(query: string | undefined, page: number, pageSize: number): Promise<Page<EscortPenaltyListRecord>> {
    const where = query ? {
      OR: [
        { reason: { contains: query, mode: "insensitive" as const } },
        { participant: { is: { name: { contains: query, mode: "insensitive" as const } } } },
        { participant: { is: { playerProfile: { is: { gameId: { contains: query, mode: "insensitive" as const } } } } } },
        { participant: { is: { order: { is: { item: { contains: query, mode: "insensitive" as const } } } } } },
        { participant: { is: { order: { is: { buyerName: { contains: query, mode: "insensitive" as const } } } } } },
      ],
    } : {};
    const include = {
      participant: { include: { playerProfile: true, order: true } },
      createdBy: true,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.escortPenalty.findMany({
        where,
        include,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.escortPenalty.count({ where }),
    ]);
    return { items: items.map(mapPenaltyList), total, page, pageSize };
  }

  async deleteEscortPenalty(id: string, clearPaid = false): Promise<EscortPenaltyListRecord | null> {
    const deleted = await this.prisma.$transaction(async (database) => {
      const penalty = await database.escortPenalty.findUnique({
        where: { id },
        include: {
          participant: { include: { playerProfile: true, order: true } },
          createdBy: true,
        },
      });
      if (!penalty) return null;
      if (penalty.participant.paid) {
        if (!clearPaid) throw new Error("Сначала снимите отметку о выплате игроку");
        await database.escortParticipant.update({
          where: { id: penalty.participantId },
          data: { paid: false, paidAt: null },
        });
      }

      const violationDate = penalty.violationDate
        ?? new Date(Date.UTC(penalty.createdAt.getUTCFullYear(), penalty.createdAt.getUTCMonth(), penalty.createdAt.getUTCDate()));
      const nextDate = new Date(violationDate.getTime() + 24 * 60 * 60 * 1000);
      await database.escortPenalty.delete({ where: { id } });

      const dayWhere = {
        ...(penalty.playerProfileId ? { playerProfileId: penalty.playerProfileId } : { participantId: penalty.participantId }),
        OR: [
          { violationDate: { gte: violationDate, lt: nextDate } },
          { violationDate: null, createdAt: { gte: violationDate, lt: nextDate } },
        ],
      };
      const remaining = await database.escortPenalty.findMany({
        where: dayWhere,
        include: { participant: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      if (remaining.some((item: any) => item.participant.paid)) {
        throw new Error("Сначала снимите отметку о выплате у всех затронутых игроков");
      }
      const remainingIds = remaining.map((item: any) => item.id);
      for (let index = 0; index < remaining.length; index += 1) {
        await database.escortPenalty.update({ where: { id: remaining[index]!.id }, data: { sequence: -(index + 1) } });
      }

      const withheldByParticipant = new Map<string, bigint>();
      for (const item of remaining) {
        if (!withheldByParticipant.has(item.participantId)) {
          const other = await database.escortPenalty.aggregate({
            where: { participantId: item.participantId, id: { notIn: remainingIds } },
            _sum: { amountUahMinor: true },
          });
          withheldByParticipant.set(item.participantId, other._sum.amountUahMinor ?? 0n);
        }
      }
      for (let index = 0; index < remaining.length; index += 1) {
        const item = remaining[index]!;
        const sequence = index + 1;
        const calculated = sequence <= 4
          ? calculatePenaltyAmount(item.participant.shareUahMinor, sequence)
          : { percentage: 0, amountUahMinor: 0n };
        const alreadyWithheld = withheldByParticipant.get(item.participantId) ?? 0n;
        const available = item.participant.shareUahMinor - alreadyWithheld;
        const amountUahMinor = available <= 0n ? 0n : calculated.amountUahMinor > available ? available : calculated.amountUahMinor;
        withheldByParticipant.set(item.participantId, alreadyWithheld + amountUahMinor);
        await database.escortPenalty.update({
          where: { id: item.id },
          data: { sequence, percentage: calculated.percentage, amountUahMinor },
        });
      }

      if (penalty.playerProfileId) {
        const allProfilePenalties = await database.escortPenalty.findMany({
          where: { playerProfileId: penalty.playerProfileId },
          orderBy: [{ violationDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        });
        const grouped = new Map<string, typeof allProfilePenalties>();
        for (const item of allProfilePenalties) {
          const key = (item.violationDate ?? item.createdAt).toISOString().slice(0, 10);
          grouped.set(key, [...(grouped.get(key) ?? []), item]);
        }
        const permanentlyBanned = [...grouped.values()].some((items) => items.length >= 5);
        const now = new Date();
        const suspensionCandidates = [...grouped.values()]
          .filter((items) => items.length >= 4)
          .map((items) => new Date(items[3]!.createdAt.getTime() + 24 * 60 * 60 * 1000))
          .filter((value) => value > now)
          .sort((left, right) => right.getTime() - left.getTime());
        const suspendedUntil = permanentlyBanned ? null : suspensionCandidates[0] ?? null;
        await database.escortPlayerProfile.update({
          where: { id: penalty.playerProfileId },
          data: {
            permanentlyBanned,
            bannedAt: permanentlyBanned ? penalty.participant.playerProfile?.bannedAt ?? now : null,
            suspendedUntil,
          },
        });
        const restricted = permanentlyBanned || Boolean(suspendedUntil);
        await database.escortParticipant.updateMany({
          where: { playerProfileId: penalty.playerProfileId, replacedAt: null },
          data: { active: !restricted, excludedAt: restricted ? now : null },
        });
      } else {
        const restricted = remaining.length >= 4;
        await database.escortParticipant.update({
          where: { id: penalty.participantId },
          data: { active: !restricted, excludedAt: restricted ? penalty.participant.excludedAt ?? new Date() : null },
        });
      }

      return penalty;
    }, { isolationLevel: "Serializable" });
    return deleted ? mapPenaltyList(deleted) : null;
  }

  async listEscortPlayerProfiles(query: string | undefined, page: number, pageSize: number): Promise<Page<EscortPlayerProfileRecord>> {
    const where = query ? {
      OR: [
        { gameId: { contains: query, mode: "insensitive" as const } },
        { displayName: { contains: query, mode: "insensitive" as const } },
        { contact: { contains: query, mode: "insensitive" as const } },
      ],
    } : {};
    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.escortPlayerProfile.findMany({
        where,
        include: { _count: { select: { participants: true, penalties: true } } },
        orderBy: [{ permanentlyBanned: "desc" }, { updatedAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.escortPlayerProfile.count({ where }),
    ]);
    const items = await Promise.all(profiles.map(async (profile) => {
      const participants = await this.prisma.escortParticipant.findMany({
        where: { playerProfileId: profile.id },
        include: { penalties: true },
      });
      const earnedUahMinor = participants.reduce((sum, item) => sum + item.shareUahMinor, 0n);
      const withheldUahMinor = participants.reduce((sum, item) => sum + item.penalties.reduce((value, penalty) => value + penalty.amountUahMinor, 0n), 0n);
      const paidUahMinor = participants.filter((item) => item.paid && !item.replacedAt).reduce(
        (sum, item) => sum + item.shareUahMinor - item.penalties.reduce((value, penalty) => value + penalty.amountUahMinor, 0n), 0n,
      );
      const balanceUahMinor = participants.filter((item) => !item.paid && !item.replacedAt).reduce(
        (sum, item) => sum + item.shareUahMinor - item.penalties.reduce((value, penalty) => value + penalty.amountUahMinor, 0n), 0n,
      );
      return mapPlayerProfile({
        ...profile,
        earnedUahMinor,
        withheldUahMinor,
        paidUahMinor,
        balanceUahMinor,
      });
    }));
    return { items, total, page, pageSize };
  }

  async getEscortPlayerProfile(id: string): Promise<EscortPlayerProfileRecord | null> {
    const profile = await this.prisma.escortPlayerProfile.findUnique({
      where: { id },
      include: { _count: { select: { participants: true, penalties: true } } },
    });
    if (!profile) return null;
    const participants = await this.prisma.escortParticipant.findMany({ where: { playerProfileId: id }, include: { penalties: true } });
    const earnedUahMinor = participants.reduce((sum, item) => sum + item.shareUahMinor, 0n);
    const withheldUahMinor = participants.reduce((sum, item) => sum + item.penalties.reduce((value, penalty) => value + penalty.amountUahMinor, 0n), 0n);
    const paidUahMinor = participants.filter((item) => item.paid && !item.replacedAt).reduce((sum, item) => sum + item.shareUahMinor - item.penalties.reduce((value, penalty) => value + penalty.amountUahMinor, 0n), 0n);
    const balanceUahMinor = participants.filter((item) => !item.paid && !item.replacedAt).reduce((sum, item) => sum + item.shareUahMinor - item.penalties.reduce((value, penalty) => value + penalty.amountUahMinor, 0n), 0n);
    return mapPlayerProfile({
      ...profile,
      earnedUahMinor,
      withheldUahMinor,
      paidUahMinor,
      balanceUahMinor,
    });
  }

  async findEscortPlayerProfileByGameId(gameId: string): Promise<EscortPlayerProfileRecord | null> {
    const profile = await this.prisma.escortPlayerProfile.findUnique({ where: { gameId } });
    return profile ? mapPlayerProfile(profile) : null;
  }

  async listEscortOrdersByPlayerProfile(playerProfileId: string): Promise<EscortOrderRecord[]> {
    const orders = await this.prisma.escortOrder.findMany({
      where: { participants: { some: { playerProfileId } } },
      include: escortOrderInclude,
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    });
    return orders.map(mapEscortOrder);
  }

  async rotateEscortPortalCode(id: string, portalCodeHash: string): Promise<EscortPlayerProfileRecord | null> {
    const existing = await this.prisma.escortPlayerProfile.findUnique({ where: { id } });
    if (!existing) return null;
    return mapPlayerProfile(await this.prisma.escortPlayerProfile.update({ where: { id }, data: { portalCodeHash } }));
  }

  async findBuyerOrder(gameId: string, reviewCodeHash: string): Promise<EscortOrderRecord | null> {
    const order = await this.prisma.escortOrder.findFirst({
      where: { buyerGameId: gameId, reviewCodeHash },
      include: escortOrderInclude,
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    });
    return order ? mapEscortOrder(order) : null;
  }

  async createPenaltyAppeal(penaltyId: string, playerProfileId: string, message: string): Promise<PenaltyAppealRecord | null> {
    const penalty = await this.prisma.escortPenalty.findFirst({ where: { id: penaltyId, playerProfileId } });
    if (!penalty) return null;
    const existing = await this.prisma.penaltyAppeal.findFirst({ where: { penaltyId, playerProfileId, status: "pending" } });
    if (existing) throw new Error("Оскарження цього штрафу вже очікує розгляду");
    return mapAppeal(await this.prisma.penaltyAppeal.create({
      data: { penaltyId, playerProfileId, message },
      include: { penalty: true, playerProfile: true, reviewedBy: true },
    }));
  }

  async listPenaltyAppeals(status?: PenaltyAppealStatus): Promise<PenaltyAppealRecord[]> {
    const values = await this.prisma.penaltyAppeal.findMany({
      where: status ? { status: status as any } : {},
      include: { penalty: true, playerProfile: true, reviewedBy: true },
      orderBy: { createdAt: "desc" },
    });
    return values.map(mapAppeal);
  }

  async updatePenaltyAppeal(id: string, input: { status: PenaltyAppealStatus; adminReply: string | null; reviewedById: string }): Promise<PenaltyAppealRecord | null> {
    const existing = await this.prisma.penaltyAppeal.findUnique({ where: { id } });
    if (!existing) return null;
    return mapAppeal(await this.prisma.penaltyAppeal.update({
      where: { id },
      data: { ...input, reviewedAt: new Date() } as any,
      include: { penalty: true, playerProfile: true, reviewedBy: true },
    }));
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

  async rotateEscortReviewCode(id: string, reviewCodeHash: string, issuedAt: Date): Promise<EscortOrderRecord | null> {
    const existing = await this.prisma.escortOrder.findUnique({ where: { id } });
    if (!existing) return null;
    if (existing.reviewCodeConsumedAt) throw new Error("Отзыв для этого заказа уже оставлен");
    return mapEscortOrder(await this.prisma.escortOrder.update({
      where: { id },
      data: { reviewCodeHash, reviewCodeIssuedAt: issuedAt },
      include: escortOrderInclude,
    }));
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

  async listAdmins(): Promise<AdminRecord[]> {
    const values = await this.prisma.admin.findMany({ orderBy: [{ createdAt: "asc" }, { username: "asc" }] });
    return values.map(mapAdmin);
  }

  async createAdmin(username: string, passwordHash: string, role: AdminRole = "admin"): Promise<AdminRecord> {
    return mapAdmin(await this.prisma.admin.create({ data: { username, passwordHash, role: role as any } }));
  }

  async updateAdmin(id: string, input: { role?: AdminRole; active?: boolean; passwordHash?: string; twoFactorSecret?: string | null; twoFactorEnabled?: boolean }): Promise<AdminRecord | null> {
    const existing = await this.prisma.admin.findUnique({ where: { id } });
    if (!existing) return null;
    return mapAdmin(await this.prisma.admin.update({ where: { id }, data: input as any }));
  }

  async createAdminSession(
    input: { tokenHash: string; csrfToken: string; adminId: string; expiresAt: Date },
    presence: AdminSessionPresence,
  ): Promise<AdminSessionRecord> {
    const value = await withAccessTransaction(this.prisma, async (database) => {
      await database.adminSession.deleteMany({ where: { expiresAt: { lte: presence.now } } });
      await reconcileAdminAccess(database, presence);
      const admin = await database.admin.findUnique({ where: { id: input.adminId }, select: { role: true } });
      const operator = await database.adminSession.findFirst({ where: { accessMode: "operator" }, select: { id: true } });
      return database.adminSession.create({
        data: {
          ...input,
          accessMode: admin?.role === "observer" || operator ? "observer" : "operator",
          lastSeenAt: presence.now,
        },
        include: { admin: true },
      });
    });
    return mapSession(value);
  }

  async setAdminPasskeyChallenge(id: string, challenge: string | null, expiresAt: Date | null): Promise<AdminRecord | null> {
    const existing = await this.prisma.admin.findUnique({ where: { id } });
    if (!existing) return null;
    return mapAdmin(await this.prisma.admin.update({ where: { id }, data: { passkeyChallenge: challenge, passkeyChallengeExpiresAt: expiresAt } }));
  }

  async listAdminPasskeys(adminId: string): Promise<AdminPasskeyRecord[]> {
    return (await this.prisma.adminPasskey.findMany({ where: { adminId }, orderBy: { createdAt: "desc" } })).map(mapPasskey);
  }

  async findAdminPasskeyByCredentialId(credentialId: string): Promise<AdminPasskeyRecord | null> {
    const value = await this.prisma.adminPasskey.findUnique({ where: { credentialId }, include: { admin: true } });
    return value ? mapPasskey(value) : null;
  }

  async createAdminPasskey(input: Omit<AdminPasskeyRecord, "id" | "createdAt" | "lastUsedAt" | "admin">): Promise<AdminPasskeyRecord> {
    return mapPasskey(await this.prisma.adminPasskey.create({ data: { ...input, publicKey: Buffer.from(input.publicKey) } as any }));
  }

  async updateAdminPasskeyCounter(id: string, counter: bigint): Promise<void> {
    await this.prisma.adminPasskey.update({ where: { id }, data: { counter, lastUsedAt: new Date() } });
  }

  async deleteAdminPasskey(id: string, adminId: string): Promise<boolean> {
    const result = await this.prisma.adminPasskey.deleteMany({ where: { id, adminId } });
    return result.count > 0;
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

  async createAuditLog(input: {
    adminId: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.auditLog.create({ data: input as any });
  }

  async listAuditLogs(page: number, pageSize: number): Promise<Page<AuditLogRecord>> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        include: { admin: { select: { username: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count(),
    ]);
    return {
      items: items.map((item: any) => ({
        id: item.id,
        adminId: item.adminId,
        adminUsername: item.admin?.username ?? null,
        action: item.action,
        entityType: item.entityType,
        entityId: item.entityId,
        details: item.details as Record<string, unknown> | null,
        createdAt: item.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  async financialSummary(from: Date, to: Date): Promise<FinancialSummary> {
    const orders = await this.prisma.escortOrder.findMany({
      where: { status: { not: "cancelled" }, orderDate: { gte: from, lte: to } },
      include: { participants: { include: { penalties: true } } },
    });
    let grossUahMinor = 0n;
    let directorUahMinor = 0n;
    let creatorUahMinor = 0n;
    let escortPoolUahMinor = 0n;
    let penaltiesUahMinor = 0n;
    let paidToEscortsUahMinor = 0n;
    let unpaidToEscortsUahMinor = 0n;
    for (const order of orders) {
      grossUahMinor += order.amountUahMinor;
      directorUahMinor += order.directorAmountMinor;
      creatorUahMinor += order.creatorAmountMinor;
      escortPoolUahMinor += order.escortPoolMinor;
      for (const participant of order.participants) {
        const withheld = participant.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n);
        penaltiesUahMinor += withheld;
        if (participant.replacedAt) continue;
        const payout = participant.shareUahMinor - withheld;
        if (participant.paid) paidToEscortsUahMinor += payout;
        else unpaidToEscortsUahMinor += payout;
      }
    }
    return {
      from,
      to,
      orderCount: orders.length,
      grossUahMinor,
      directorUahMinor,
      creatorUahMinor,
      escortPoolUahMinor,
      penaltiesUahMinor,
      paidToEscortsUahMinor,
      unpaidToEscortsUahMinor,
    };
  }

  async dashboardCounts(): Promise<DashboardCounts> {
    const [pendingReviews, openTickets, inProgressTickets, totalApprovedReviews, completedEscortOrders] = await this.prisma.$transaction([
      this.prisma.review.count({ where: { status: "pending" } }),
      this.prisma.supportTicket.count({ where: { status: "open" } }),
      this.prisma.supportTicket.count({ where: { status: "in_progress" } }),
      this.prisma.review.count({ where: { status: "approved" } }),
      this.prisma.escortOrder.count({ where: { status: { in: ["completed", "paid"] } } }),
    ]);
    return { pendingReviews, openTickets, inProgressTickets, totalApprovedReviews, completedEscortOrders };
  }

  async createNotificationLog(input: { eventType: string; destination: string; status: "sent" | "failed" | "skipped"; error?: string }): Promise<void> {
    await this.prisma.notificationLog.create({ data: input as any });
  }

  async healthCheck(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async createBackup(): Promise<Record<string, unknown>> {
    const [profiles, orders, participants, penalties, appeals, reviews, tickets, messages, notifications, auditLogs] = await this.prisma.$transaction([
      this.prisma.escortPlayerProfile.findMany(),
      this.prisma.escortOrder.findMany(),
      this.prisma.escortParticipant.findMany(),
      this.prisma.escortPenalty.findMany(),
      this.prisma.penaltyAppeal.findMany(),
      this.prisma.review.findMany(),
      this.prisma.supportTicket.findMany(),
      this.prisma.supportMessage.findMany(),
      this.prisma.notificationLog.findMany(),
      this.prisma.auditLog.findMany(),
    ]);
    const safe = (value: unknown): unknown => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) return value.map(safe);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
      return value;
    };
    return safe({ version: 1, createdAt: new Date(), tables: { profiles, orders, participants, penalties, appeals, reviews, tickets, messages, notifications, auditLogs } }) as Record<string, unknown>;
  }

  async restoreBackup(data: unknown): Promise<Record<string, number>> {
    const input = data as any;
    if (input?.version !== 1 || !input.tables || typeof input.tables !== "object") throw new Error("Непідтримуваний формат резервної копії");
    const tables = input.tables;
    const arrays = ["profiles", "orders", "participants", "penalties", "appeals", "reviews", "tickets", "messages", "notifications", "auditLogs"];
    if (!arrays.every((key) => Array.isArray(tables[key]))) throw new Error("Резервна копія пошкоджена");
    const revive = (items: any[], dates: string[], bigints: string[] = []) => items.map((item) => ({
      ...item,
      ...Object.fromEntries(dates.filter((key) => item[key] != null).map((key) => [key, new Date(item[key])])),
      ...Object.fromEntries(bigints.filter((key) => item[key] != null).map((key) => [key, BigInt(item[key])])),
    }));
    const profiles = revive(tables.profiles, ["suspendedUntil", "bannedAt", "createdAt", "updatedAt"]);
    const orders = revive(tables.orders, ["reviewCodeIssuedAt", "reviewCodeConsumedAt", "orderDate", "createdAt", "updatedAt"], ["originalAmountMinor", "exchangeRateMicros", "amountUahMinor", "developerAmountMinor", "directorAmountMinor", "creatorAmountMinor", "escortPoolMinor"]);
    const participants = revive(tables.participants, ["paidAt", "replacedAt", "excludedAt", "createdAt"], ["shareUahMinor"]);
    const penalties = revive(tables.penalties, ["violationDate", "createdAt"], ["amountUahMinor"]);
    const appeals = revive(tables.appeals, ["createdAt", "reviewedAt"]);
    const reviews = revive(tables.reviews, ["createdAt", "moderatedAt"]);
    const tickets = revive(tables.tickets, ["createdAt", "updatedAt"]);
    const messages = revive(tables.messages, ["createdAt"]);
    const notifications = revive(tables.notifications, ["createdAt"]);
    const auditLogs = revive(tables.auditLogs, ["createdAt"]);
    await this.prisma.$transaction(async (database: any) => {
      await database.penaltyAppeal.deleteMany();
      await database.escortPenalty.deleteMany();
      await database.review.deleteMany();
      await database.escortParticipant.deleteMany();
      await database.escortOrder.deleteMany();
      await database.escortPlayerProfile.deleteMany();
      await database.supportMessage.deleteMany();
      await database.supportTicket.deleteMany();
      await database.notificationLog.deleteMany();
      await database.auditLog.deleteMany();
      if (profiles.length) await database.escortPlayerProfile.createMany({ data: profiles });
      if (orders.length) await database.escortOrder.createMany({ data: orders });
      if (participants.length) await database.escortParticipant.createMany({ data: participants });
      if (penalties.length) await database.escortPenalty.createMany({ data: penalties });
      if (appeals.length) await database.penaltyAppeal.createMany({ data: appeals });
      if (reviews.length) await database.review.createMany({ data: reviews });
      if (tickets.length) await database.supportTicket.createMany({ data: tickets });
      if (messages.length) await database.supportMessage.createMany({ data: messages });
      if (notifications.length) await database.notificationLog.createMany({ data: notifications });
      if (auditLogs.length) await database.auditLog.createMany({ data: auditLogs });
    });
    return Object.fromEntries(arrays.map((key) => [key, tables[key].length]));
  }

  async clearEscortOperations(): Promise<Record<string, number>> {
    return this.prisma.$transaction(async (database) => {
      const [orders, participants, penalties, appeals] = await Promise.all([
        database.escortOrder.count(),
        database.escortParticipant.count(),
        database.escortPenalty.count(),
        database.penaltyAppeal.count(),
      ]);
      await database.penaltyAppeal.deleteMany();
      await database.escortPenalty.deleteMany();
      await database.escortParticipant.deleteMany();
      await database.escortOrder.deleteMany();
      const auditLogs = await database.auditLog.deleteMany({
        where: {
          OR: [
            { entityType: { in: ["escort_order", "escort_participant", "escort_penalty", "penalty_appeal"] } },
            { action: { startsWith: "escort_" } },
            { action: { startsWith: "telegram_" } },
            { action: "penalty_appeal_created" },
          ],
        },
      });
      return { orders, participants, penalties, appeals, auditLogs: auditLogs.count };
    });
  }
}
