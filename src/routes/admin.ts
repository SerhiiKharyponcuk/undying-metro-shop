import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { calculateEscortSplit, formatMinor, formatRate, parseMoneyToMinor, parseRateToMicros } from "../lib/escort-calculation.js";
import { getOfficialNbuRate } from "../lib/nbu.js";
import { cleanPlainText, constantTimeEqual, containsMarkup, hashSecret, randomToken, sha256, verifySecret } from "../lib/security.js";
import type { AppStore } from "../store/store.js";

const COOKIE_NAME = "undying_admin_session";

const plainText = (minimum: number, maximum: number) =>
  z.string().transform(cleanPlainText).pipe(z.string().min(minimum).max(maximum).refine((value) => !containsMarkup(value), "HTML и скрипты запрещены"));

const loginBody = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(10).max(256),
});
const optionalQueryValue = (value: unknown) => value === "" ? undefined : value;
const reviewQuery = z.object({
  status: z.preprocess(optionalQueryValue, z.enum(["pending", "approved", "rejected"]).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const reviewUpdate = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
  adminReply: z.union([plainText(2, 1200), z.literal(""), z.null()]).optional().default(null),
});
const ticketQuery = z.object({
  status: z.preprocess(optionalQueryValue, z.enum(["open", "in_progress", "waiting_user", "closed"]).optional()),
  query: z.string().transform(cleanPlainText).pipe(z.string().max(80)).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const idParams = z.object({ id: z.string().uuid() });
const ticketStatusBody = z.object({ status: z.enum(["open", "in_progress", "waiting_user", "closed"]) });
const messageBody = z.object({ message: plainText(2, 3000) });
const scalarText = z.union([z.string(), z.number()]).transform((value) => String(value).trim());
const orderDateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const escortOrderBody = z.object({
  item: plainText(2, 160),
  buyerName: plainText(2, 64),
  buyerContact: z.union([plainText(3, 128), z.literal("")]).optional().default(""),
  amount: scalarText,
  currency: z.enum(["UAH", "EUR", "USD"]),
  exchangeRate: z.union([scalarText, z.literal("")]).optional().default(""),
  orderDate: orderDateValue,
  escorts: z.array(z.object({
    name: plainText(2, 64),
    contact: z.union([plainText(3, 128), z.literal("")]).optional().default(""),
  })).min(1).max(3),
});
const escortOrderQuery = z.object({
  status: z.preprocess(optionalQueryValue, z.enum(["planned", "completed", "paid", "cancelled"]).optional()),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(30),
});
const escortStatusBody = z.object({ status: z.enum(["planned", "completed", "paid", "cancelled"]) });
const participantPaidBody = z.object({ paid: z.boolean() });
const participantParams = z.object({ id: z.string().uuid(), participantId: z.string().uuid() });
const rateQuery = z.object({ currency: z.enum(["UAH", "EUR", "USD"]), date: orderDateValue });

function orderDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function serializeEscortOrder(order: any) {
  return {
    id: order.id,
    item: order.item,
    buyerName: order.buyerName,
    buyerContact: order.buyerContact,
    originalAmount: formatMinor(order.originalAmountMinor),
    currency: order.currency,
    exchangeRate: formatRate(order.exchangeRateMicros),
    rateSource: order.rateSource,
    amountUah: formatMinor(order.amountUahMinor),
    developerAmountUah: formatMinor(order.developerAmountMinor),
    escortPoolUah: formatMinor(order.escortPoolMinor),
    orderDate: order.orderDate,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    participants: order.participants.map((participant: any) => ({
      id: participant.id,
      name: participant.name,
      contact: participant.contact,
      shareUah: formatMinor(participant.shareUahMinor),
      paid: participant.paid,
      paidAt: participant.paidAt,
    })),
  };
}

function sessionCookie(request: FastifyRequest): string {
  const signed = request.cookies[COOKIE_NAME];
  if (!signed) return "";
  const result = request.unsignCookie(signed);
  return result.valid ? result.value : "";
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: { store: AppStore; config: AppConfig },
): Promise<void> {
  const { store, config } = dependencies;

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = sessionCookie(request);
    if (!rawToken) return reply.code(401).send({ error: "Требуется вход администратора" });
    const session = await store.findAdminSession(sha256(rawToken));
    if (!session || !session.admin.active || session.expiresAt <= new Date()) {
      if (rawToken) await store.deleteAdminSession(sha256(rawToken));
      return reply.code(401).send({ error: "Сессия истекла" });
    }
    request.adminAuth = { admin: session.admin, session };
    await store.touchAdminSession(session.id, new Date());
  };

  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.adminAuth) return reply.code(401).send({ error: "Требуется вход администратора" });
    const header = request.headers["x-csrf-token"];
    const token = typeof header === "string" ? header : "";
    if (!token || !constantTimeEqual(token, request.adminAuth.session.csrfToken)) {
      return reply.code(403).send({ error: "Недействительный CSRF-токен" });
    }
  };

  app.post(
    "/api/admin/login",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Проверьте логин и пароль" });
      const username = parsed.data.username.toLowerCase();
      const admin = await store.findAdminByUsername(username);
      let valid = false;
      if (admin) valid = await verifySecret(admin.passwordHash, parsed.data.password);
      else await hashSecret(parsed.data.password);
      if (!admin || !admin.active || !valid) return reply.code(401).send({ error: "Неверный логин или пароль" });

      await store.deleteExpiredAdminSessions(new Date());
      const rawToken = randomToken();
      const csrfToken = randomToken(24);
      const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
      await store.createAdminSession({ tokenHash: sha256(rawToken), csrfToken, adminId: admin.id, expiresAt });
      reply.setCookie(COOKIE_NAME, rawToken, {
        path: "/api/admin",
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: config.nodeEnv === "production" ? "none" : "lax",
        signed: true,
        expires: expiresAt,
      });
      return { admin: { id: admin.id, username: admin.username }, csrfToken, expiresAt };
    },
  );

  app.post("/api/admin/logout", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const token = sessionCookie(request);
    if (token) await store.deleteAdminSession(sha256(token));
    reply.clearCookie(COOKIE_NAME, { path: "/api/admin" });
    return { success: true };
  });

  app.get("/api/admin/dashboard", { preHandler: requireAdmin }, async (request) => ({
    admin: { id: request.adminAuth!.admin.id, username: request.adminAuth!.admin.username },
    csrfToken: request.adminAuth!.session.csrfToken,
    counts: await store.dashboardCounts(),
  }));

  app.get("/api/admin/exchange-rate", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = rateQuery.safeParse(request.query);
    if (!parsed.success || !orderDate(parsed.data.date)) return reply.code(400).send({ error: "Проверьте валюту и дату" });
    try {
      const rate = await getOfficialNbuRate(parsed.data.currency, parsed.data.date);
      return { currency: parsed.data.currency, date: parsed.data.date, rate: formatRate(parseRateToMicros(rate)) };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "Не удалось получить курс НБУ" });
    }
  });

  app.get("/api/admin/escort-orders", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = escortOrderQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные параметры" });
    const page = await store.listEscortOrders(parsed.data.status, parsed.data.page, parsed.data.pageSize);
    return { ...page, items: page.items.map(serializeEscortOrder) };
  });

  app.post("/api/admin/escort-orders", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const parsed = escortOrderBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные сопровождения" });
    const date = orderDate(parsed.data.orderDate);
    if (!date) return reply.code(400).send({ error: "Укажите корректную дату" });

    try {
      const originalAmountMinor = parseMoneyToMinor(parsed.data.amount);
      let rateSource: "uah" | "nbu" | "manual" = "uah";
      let rate = 1;
      if (parsed.data.currency !== "UAH") {
        if (parsed.data.exchangeRate) {
          rate = Number(parsed.data.exchangeRate.replace(",", "."));
          rateSource = "manual";
        } else {
          rate = await getOfficialNbuRate(parsed.data.currency, parsed.data.orderDate);
          rateSource = "nbu";
        }
      }
      const exchangeRateMicros = parseRateToMicros(rate);
      const calculation = calculateEscortSplit(originalAmountMinor, exchangeRateMicros, parsed.data.escorts.length);
      const order = await store.createEscortOrder({
        item: parsed.data.item,
        buyerName: parsed.data.buyerName,
        buyerContact: parsed.data.buyerContact || null,
        originalAmountMinor,
        currency: parsed.data.currency,
        exchangeRateMicros,
        rateSource,
        amountUahMinor: calculation.amountUahMinor,
        developerAmountMinor: calculation.developerAmountMinor,
        escortPoolMinor: calculation.escortPoolMinor,
        orderDate: date,
        createdById: request.adminAuth!.admin.id,
        participants: parsed.data.escorts.map((escort, index) => ({
          name: escort.name,
          contact: escort.contact || null,
          shareUahMinor: calculation.shares[index]!,
        })),
      });
      return reply.code(201).send(serializeEscortOrder(order));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось рассчитать сопровождение";
      return reply.code(message.includes("НБУ") ? 503 : 400).send({ error: message });
    }
  });

  app.patch("/api/admin/escort-orders/:id/status", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = escortStatusBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте статус" });
    const order = await store.updateEscortOrderStatus(params.data.id, body.data.status);
    return order ? serializeEscortOrder(order) : reply.code(404).send({ error: "Сопровождение не найдено" });
  });

  app.patch("/api/admin/escort-orders/:id/participants/:participantId", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const params = participantParams.safeParse(request.params);
    const body = participantPaidBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте данные выплаты" });
    const order = await store.updateEscortParticipantPaid(params.data.id, params.data.participantId, body.data.paid);
    return order ? serializeEscortOrder(order) : reply.code(404).send({ error: "Игрок или сопровождение не найдено" });
  });

  app.get("/api/admin/reviews", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = reviewQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные параметры" });
    const page = await store.listReviews(parsed.data.status, parsed.data.page, parsed.data.pageSize);
    return {
      ...page,
      items: page.items.map(({ contentHash: _contentHash, ipHash: _ipHash, ...review }) => review),
    };
  });

  app.patch("/api/admin/reviews/:id", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = reviewUpdate.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте данные модерации" });
    const review = await store.updateReview(params.data.id, {
      status: body.data.status,
      adminReply: body.data.adminReply || null,
      moderatedById: request.adminAuth!.admin.id,
    });
    if (!review) return reply.code(404).send({ error: "Отзыв не найден" });
    const { contentHash: _contentHash, ipHash: _ipHash, ...safeReview } = review;
    return safeReview;
  });

  app.get("/api/admin/tickets", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = ticketQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные параметры" });
    const page = await store.listTickets(parsed.data.status, parsed.data.query, parsed.data.page, parsed.data.pageSize);
    return {
      ...page,
      items: page.items.map(({ secretTokenHash: _secret, ipHash: _ip, ...ticket }) => ticket),
    };
  });

  app.get("/api/admin/tickets/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный ID" });
    const ticket = await store.findTicketById(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Обращение не найдено" });
    const { secretTokenHash: _secret, ipHash: _ip, ...safeTicket } = ticket;
    return safeTicket;
  });

  app.post("/api/admin/tickets/:id/messages", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = messageBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте сообщение" });
    const ticket = await store.findTicketById(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Обращение не найдено" });
    if (ticket.status === "closed") return reply.code(409).send({ error: "Обращение закрыто" });
    const message = await store.addTicketMessage(ticket.id, "admin", body.data.message, request.adminAuth!.admin.id);
    return reply.code(201).send(message);
  });

  app.patch("/api/admin/tickets/:id/status", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = ticketStatusBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте статус" });
    const ticket = await store.updateTicketStatus(params.data.id, body.data.status, request.adminAuth!.admin.id);
    if (!ticket) return reply.code(404).send({ error: "Обращение не найдено" });
    const { secretTokenHash: _secret, ipHash: _ip, ...safeTicket } = ticket;
    return safeTicket;
  });
}
