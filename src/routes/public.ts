import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AdminNotifier } from "../lib/telegram.js";
import { cleanPlainText, constantTimeEqual, containsMarkup, contentFingerprint, hashIp, hashSecret, keyedHash, randomCode, randomToken, verifySecret } from "../lib/security.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import type { AppStore } from "../store/store.js";
import type { SupportTicketRecord } from "../types/domain.js";

const plainText = (minimum: number, maximum: number) =>
  z.string().transform(cleanPlainText).pipe(z.string().min(minimum).max(maximum).refine((value) => !containsMarkup(value), "HTML и скрипты запрещены"));

const reviewBody = z.object({
  name: plainText(2, 64),
  contact: z.union([plainText(3, 128), z.literal("")]).optional().default(""),
  buyerGameId: z.string().trim().regex(/^\d{5,20}$/, "Введите корректный PUBG ID"),
  reviewCode: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{10}$/, "Введите 10-значный код покупки"),
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
const gameIdParams = z.object({ gameId: z.string().regex(/^\d{5,20}$/) });
const buyerOrderBody = z.object({ gameId: z.string().regex(/^\d{5,20}$/), code: z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{10}$/) });
const appealBody = z.object({ penaltyId: z.string().uuid(), message: plainText(10, 1200) });
const telegramUpdate = z.object({
  message: z.object({
    chat: z.object({ id: z.union([z.string(), z.number()]) }),
    text: z.string().max(500),
  }).optional(),
});

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

  app.get("/api/health/ready", async (_request, reply) => {
    try {
      await store.healthCheck();
      return { status: "ready", database: "ok", timestamp: new Date().toISOString() };
    } catch {
      return reply.code(503).send({ status: "unavailable", database: "error", timestamp: new Date().toISOString() });
    }
  });

  app.get("/api/escort-portal/:gameId", async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const code = typeof request.headers["x-player-code"] === "string" ? request.headers["x-player-code"].trim().toUpperCase() : "";
    if (!params.success || !code) return reply.code(401).send({ error: "PUBG ID або код доступу неправильний" });
    const profile = await store.findEscortPlayerProfileByGameId(params.data.gameId);
    if (!profile?.portalCodeHash || !constantTimeEqual(profile.portalCodeHash, keyedHash(code, config.reviewCodePepper))) {
      return reply.code(401).send({ error: "PUBG ID або код доступу неправильний" });
    }
    const orders = await store.listEscortOrdersByPlayerProfile(profile.id);
    const appeals = await store.listPenaltyAppeals();
    return {
      profile: {
        gameId: profile.gameId,
        displayName: profile.displayName,
        suspendedUntil: profile.suspendedUntil,
        permanentlyBanned: profile.permanentlyBanned,
      },
      orders: orders.map((order) => {
        const participant = order.participants.find((item) => item.playerProfileId === profile.id)!;
        const withheld = participant.penalties.reduce((sum, item) => sum + item.amountUahMinor, 0n);
        return {
          id: order.id,
          item: order.item,
          orderDate: order.orderDate,
          status: order.status,
          assignmentStatus: participant.assignmentStatus,
          shareUah: Number(participant.shareUahMinor) / 100,
          withheldUah: Number(withheld) / 100,
          payoutUah: Number(participant.shareUahMinor - withheld) / 100,
          paid: participant.paid,
          penalties: participant.penalties.map((penalty) => {
            const appeal = appeals.find((item) => item.penaltyId === penalty.id);
            return {
              id: penalty.id,
              sequence: penalty.sequence,
              percentage: penalty.percentage,
              amountUah: Number(penalty.amountUahMinor) / 100,
              reason: penalty.reason,
              createdAt: penalty.createdAt,
              appeal: appeal ? { status: appeal.status, message: appeal.message, adminReply: appeal.adminReply, createdAt: appeal.createdAt, reviewedAt: appeal.reviewedAt } : null,
            };
          }),
        };
      }),
    };
  });

  app.post("/api/escort-portal/:gameId/appeals", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
    const params = gameIdParams.safeParse(request.params);
    const body = appealBody.safeParse(request.body);
    const code = typeof request.headers["x-player-code"] === "string" ? request.headers["x-player-code"].trim().toUpperCase() : "";
    if (!params.success || !body.success || !code) return reply.code(400).send({ error: "Перевірте дані оскарження" });
    const profile = await store.findEscortPlayerProfileByGameId(params.data.gameId);
    if (!profile?.portalCodeHash || !constantTimeEqual(profile.portalCodeHash, keyedHash(code, config.reviewCodePepper))) return reply.code(401).send({ error: "Доступ заборонено" });
    try {
      const appeal = await store.createPenaltyAppeal(body.data.penaltyId, profile.id, body.data.message);
      if (!appeal) return reply.code(404).send({ error: "Штраф не знайдено" });
      await notifier.operation("penalty_appeal_created", ["⚖️ Нове оскарження штрафу", `Гравець: ${profile.displayName}`, `PUBG ID: ${profile.gameId}`]);
      return reply.code(201).send({ id: appeal.id, status: appeal.status });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Не вдалося створити оскарження" });
    }
  });

  app.post("/api/orders/lookup", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = buyerOrderBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Перевірте PUBG ID і код замовлення" });
    const order = await store.findBuyerOrder(body.data.gameId, keyedHash(body.data.code, config.reviewCodePepper));
    if (!order) return reply.code(404).send({ error: "Замовлення не знайдено" });
    return { id: order.id.slice(0, 8), item: order.item, buyerName: order.buyerName, orderDate: order.orderDate, status: order.status, amountUah: Number(order.amountUahMinor) / 100 };
  });

  app.post("/api/telegram/webhook", async (request, reply) => {
    const secret = config.telegramWebhookSecret || "";
    const provided = typeof request.headers["x-telegram-bot-api-secret-token"] === "string" ? request.headers["x-telegram-bot-api-secret-token"] : "";
    if (!secret || !provided || !constantTimeEqual(secret, provided)) return reply.code(404).send({ ok: false });
    const update = telegramUpdate.safeParse(request.body);
    if (!update.success || !update.data.message) return { ok: true };
    const chatId = String(update.data.message.chat.id);
    if (!config.telegramAdminChatIds.includes(chatId)) {
      if (config.telegramBotToken) {
        await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: `Ваш Chat ID: ${chatId}\nДодайте його в Render → TELEGRAM_ADMIN_CHAT_IDS, щоб увімкнути керування.` }),
          signal: AbortSignal.timeout(7_000),
        }).catch(() => undefined);
      }
      return { ok: true };
    }
    const [rawCommand, orderRef, value, assignment] = update.data.message.text.trim().split(/\s+/);
    const command = rawCommand?.split("@")[0]?.toLowerCase();
    const orders = await store.listEscortOrders(undefined, 1, 50);
    const order = orderRef ? orders.items.find((item) => item.id === orderRef || item.id.startsWith(orderRef)) : null;
    if (command === "/status" && order && ["planned", "completed", "paid", "cancelled"].includes(value || "")) {
      await store.updateEscortOrderStatus(order.id, value as any);
      await store.createAuditLog({ adminId: null, action: "telegram.order_status", entityType: "escort_order", entityId: order.id, details: { chatId, status: value } });
      await notifier.operation("telegram_order_status", ["🤖 Статус змінено через Telegram", `Замовлення: ${order.id.slice(0, 8)}`, `Статус: ${value}`]);
    } else if (command === "/assign" && order && ["invited", "accepted", "declined"].includes(assignment || "")) {
      const participant = order.participants.find((item) => item.id === value || item.id.startsWith(value || "") || item.playerProfile?.gameId === value);
      if (participant) {
        await store.updateEscortParticipantAssignment(order.id, participant.id, assignment as any);
        await store.createAuditLog({ adminId: null, action: "telegram.assignment", entityType: "escort_participant", entityId: participant.id, details: { chatId, orderId: order.id, status: assignment } });
        await notifier.operation("telegram_assignment", ["🤖 Призначення змінено через Telegram", `Гравець: ${participant.name}`, `Статус: ${assignment}`]);
      } else {
        await notifier.operation("telegram_help", ["Гравця не знайдено. Використовуйте PUBG ID."]);
      }
    } else if (command === "/orders") {
      await notifier.operation("telegram_orders", ["📅 Активні замовлення", ...orders.items.slice(0, 10).map((item) => `${item.id.slice(0, 8)} • ${item.orderDate.toISOString().slice(0, 10)} • ${item.buyerName} • ${item.status}`)]);
    } else {
      await notifier.operation("telegram_help", ["🤖 Undying Metro Bot", "Команди:", "/orders — показати замовлення", "/status ID planned|completed|paid|cancelled", "/assign ID PUBG_ID invited|accepted|declined"]);
    }
    return { ok: true };
  });

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
        reviewCodeHash: keyedHash(parsed.data.reviewCode, config.reviewCodePepper),
        rating: parsed.data.rating,
        text: parsed.data.text,
        contentHash,
        ipHash,
      });
      if (result.status === "not_found") {
        return reply.code(403).send({ error: "PUBG ID или одноразовый код покупки неверен" });
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
