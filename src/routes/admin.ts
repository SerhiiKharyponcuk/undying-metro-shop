import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
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
