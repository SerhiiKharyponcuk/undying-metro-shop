import type { PrismaClient } from "@prisma/client";
import type {
  AdminRecord,
  AdminSessionRecord,
  DashboardCounts,
  Page,
  ReviewRecord,
  ReviewStatus,
  SupportMessageRecord,
  SupportTicketRecord,
  TicketStatus,
} from "../types/domain.js";
import type { AppStore, NewReview, NewTicket } from "./store.js";

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
    expiresAt: value.expiresAt,
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

export class PrismaStore implements AppStore {
  constructor(private readonly prisma: PrismaClient) {}

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

  async findAdminByUsername(username: string): Promise<AdminRecord | null> {
    const value = await this.prisma.admin.findUnique({ where: { username } });
    return value ? mapAdmin(value) : null;
  }

  async createAdmin(username: string, passwordHash: string): Promise<AdminRecord> {
    return mapAdmin(await this.prisma.admin.create({ data: { username, passwordHash } }));
  }

  async createAdminSession(input: { tokenHash: string; csrfToken: string; adminId: string; expiresAt: Date }): Promise<AdminSessionRecord> {
    return mapSession(await this.prisma.adminSession.create({ data: input, include: { admin: true } }));
  }

  async findAdminSession(tokenHash: string): Promise<AdminSessionRecord | null> {
    const value = await this.prisma.adminSession.findUnique({ where: { tokenHash }, include: { admin: true } });
    return value ? mapSession(value) : null;
  }

  async touchAdminSession(id: string, now: Date): Promise<void> {
    await this.prisma.adminSession.update({ where: { id }, data: { lastSeenAt: now } });
  }

  async deleteAdminSession(tokenHash: string): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { tokenHash } });
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
