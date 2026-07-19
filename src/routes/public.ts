import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AdminNotifier } from "../lib/telegram.js";
import { cleanPlainText, containsMarkup, contentFingerprint, hashIp, hashSecret, randomCode, randomToken, verifySecret } from "../lib/security.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import type { AppStore } from "../store/store.js";
import type { SupportTicketRecord } from "../types/domain.js";

const plainText = (minimum: number, maximum: number) =>
  z.string().transform(cleanPlainText).pipe(z.string().min(minimum).max(maximum).refine((value) => !containsMarkup(value), "HTML и скрипты запрещены"));

const reviewBody = z.object({
  name: plainText(2, 64),
  contact: z.union([plainText(3, 128), z.literal("")]).optional().default(""),
  buyerGameId: z.string().trim().regex(/^\d{5,20}$/, "Введите корректный PUBG ID"),
  rating: z.coerce.number().int().min(1).max(5),
  text: plainText(10, 1200),
  turnstileToken: z.string().max(4096).optional().default(""),
});

const ticketBody = z
  .object({
    name: plainText(2, 64),
    contactType: z.enum(["telegram", "email"]),
    contact: plainText(3, 160),
    category: z.enum(["purchase", "payment", "product_problem", "partnership", "complaint", "other"]),
    subject: plainText(3, 140),
    message: plainText(10, 3000),
    turnstileToken: z.string().max(4096).optional().default(""),
  })
  .superRefine((value, context) => {
    if (value.contactType === "email" && !z.string().email().safeParse(value.contact).success) {
      context.addIssue({ code: "custom", path: ["contact"], message: "Введите корректный email" });
    }
    if (value.contactType === "telegram" && !/^@?[a-zA-Z0-9_]{5,32}$/.test(value.contact)) {
      context.addIssue({ code: "custom", path: ["contact"], message: "Введите корректный Telegram" });
    }
  });

const messageBody = z.object({ message: plainText(2, 3000) });
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(20).default(6) });
const ticketParams = z.object({ number: z.string().regex(/^UMS-\d{6}-[A-Z0-9]{4}$/) });
const managerKeys = ["manager_1", "manager_2"] as const;
const managerParams = z.object({ key: z.enum(managerKeys) });
const managerHoldSeconds = 3 * 60;

function serializeTicket(ticket: SupportTicketRecord) {
  return {
    number: ticket.publicNumber,
    name: ticket.name,
    contactType: ticket.contactType,
    contact: ticket.contact,
    category: ticket.category,
    subject: ticket.subject,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    messages: ticket.messages.map((message) => ({
      id: message.id,
      sender: message.senderType,
      message: message.message,
      createdAt: message.createdAt,
    })),
  };
}

function ticketToken(request: any): string {
  const value = request.headers["x-ticket-token"];
  return typeof value === "string" ? value : "";
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  dependencies: { store: AppStore; config: AppConfig; notifier: AdminNotifier },
): Promise<void> {
  const { store, config, notifier } = dependencies;

  app.get("/", async () => ({
    status: "ok",
    service: "Undying Metro Shop API",
    message: "Сервер работает. Проверка состояния доступна по адресу /api/health.",
  }));

  app.get("/api/health", async () => ({ status: "ok", service: "undying-metro-api", timestamp: new Date().toISOString() }));

  app.get("/api/managers", async () => {
    const now = new Date();
    const availability = await store.getManagerAvailability([...managerKeys]);
    const byKey = new Map(availability.map((item) => [item.managerKey, item.busyUntil]));
    return {
      serverTime: now,
      holdSeconds: managerHoldSeconds,
      items: managerKeys.map((key) => {
        const busyUntil = byKey.get(key) ?? null;
        const busy = Boolean(busyUntil && busyUntil > now);
        return { key, status: busy ? "busy" : "available", busyUntil: busy ? busyUntil : null };
      }),
    };
  });

  app.post(
    "/api/managers/:key/claim",
    { config: { rateLimit: { max: 12, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const params = managerParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: "Неизвестный менеджер" });
      const now = new Date();
      const result = await store.claimManager(params.data.key, now, new Date(now.getTime() + managerHoldSeconds * 1000));
      if (!result.claimed) {
        return reply.code(409).send({
          key: params.data.key,
          status: "busy",
          busyUntil: result.busyUntil,
          error: "Менеджер уже занят. Выберите другого или дождитесь освобождения.",
        });
      }
      return reply.code(201).send({ key: params.data.key, status: "busy", busyUntil: result.busyUntil });
    },
  );

  app.get("/api/reviews", async (request, reply) => {
    const parsed = pageQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные параметры страницы" });
    const page = await store.listApprovedReviews(parsed.data.page, parsed.data.pageSize);
    return {
      ...page,
      items: page.items.map((review) => ({
        id: review.id,
        name: review.name,
        rating: review.rating,
        text: review.text,
        adminReply: review.adminReply,
        createdAt: review.createdAt,
      })),
    };
  });

  app.post(
    "/api/reviews",
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const parsed = reviewBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные формы" });
      if (!(await verifyTurnstile(config, parsed.data.turnstileToken, request.ip))) {
        return reply.code(400).send({ error: "Не удалось подтвердить, что вы не робот" });
      }

      const ipHash = hashIp(request.ip, config.ipHashSalt);
      const contentHash = contentFingerprint([parsed.data.buyerGameId, parsed.data.name, parsed.data.text], config.ipHashSalt);
      const duplicateSince = new Date(Date.now() - 12 * 60 * 60 * 1000);
      if (await store.hasRecentDuplicateReview(ipHash, contentHash, duplicateSince)) {
        return reply.code(409).send({ error: "Такой отзыв уже был отправлен" });
      }

      const result = await store.createVerifiedReview({
        name: parsed.data.name,
        contact: parsed.data.contact || null,
        buyerGameId: parsed.data.buyerGameId,
        rating: parsed.data.rating,
        text: parsed.data.text,
        contentHash,
        ipHash,
      });
      if (result.status === "not_found") {
        return reply.code(403).send({ error: "PUBG ID не найден среди завершённых или оплаченных заказов" });
      }
      if (result.status === "already_reviewed") {
        return reply.code(409).send({ error: "Для покупок с этим PUBG ID отзыв уже оставлен" });
      }
      const { review } = result;
      await notifier.review(review);
      return reply.code(201).send({ id: review.id, status: "pending", message: "Отзыв отправлен на модерацию" });
    },
  );

  app.post(
    "/api/support/tickets",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const parsed = ticketBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте данные формы" });
      if (!(await verifyTurnstile(config, parsed.data.turnstileToken, request.ip))) {
        return reply.code(400).send({ error: "Не удалось подтвердить, что вы не робот" });
      }

      const token = randomToken();
      const secretTokenHash = await hashSecret(`${token}.${config.ticketTokenPepper}`);
      const date = new Date();
      const publicNumber = `UMS-${date.toISOString().slice(2, 10).replaceAll("-", "")}-${randomCode(4)}`;
      const ticket = await store.createTicket({
        publicNumber,
        secretTokenHash,
        name: parsed.data.name,
        contactType: parsed.data.contactType,
        contact: parsed.data.contact,
        category: parsed.data.category,
        subject: parsed.data.subject,
        message: parsed.data.message,
        ipHash: hashIp(request.ip, config.ipHashSalt),
      });
      await notifier.ticket(ticket);
      return reply.code(201).send({
        number: ticket.publicNumber,
        token,
        status: ticket.status,
        message: "Обращение создано. Сохраните номер заявки и секретный ключ.",
      });
    },
  );

  app.get("/api/support/tickets/:number", async (request, reply) => {
    const params = ticketParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный номер заявки" });
    const ticket = await store.findTicketByNumber(params.data.number);
    if (!ticket || !(await verifySecret(ticket.secretTokenHash, `${ticketToken(request)}.${config.ticketTokenPepper}`))) {
      return reply.code(401).send({ error: "Номер заявки или секретный ключ неверны" });
    }
    return serializeTicket(ticket);
  });

  app.post(
    "/api/support/tickets/:number/messages",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const params = ticketParams.safeParse(request.params);
      const body = messageBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте сообщение" });
      const ticket = await store.findTicketByNumber(params.data.number);
      if (!ticket || !(await verifySecret(ticket.secretTokenHash, `${ticketToken(request)}.${config.ticketTokenPepper}`))) {
        return reply.code(401).send({ error: "Номер заявки или секретный ключ неверны" });
      }
      if (ticket.status === "closed") return reply.code(409).send({ error: "Заявка закрыта" });
      const message = await store.addTicketMessage(ticket.id, "user", body.data.message);
      await notifier.ticketMessage(ticket, message);
      return reply.code(201).send({ id: message.id, status: "in_progress", createdAt: message.createdAt });
    },
  );
}
