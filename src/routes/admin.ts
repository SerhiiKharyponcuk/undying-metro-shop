import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { calculateEscortSplit, formatMinor, formatRate, parseMoneyToMinor, parseRateToMicros, PENALTY_PERCENTAGES } from "../lib/escort-calculation.js";
import { getOfficialNbuRate } from "../lib/nbu.js";
import type { AdminNotifier } from "../lib/telegram.js";
import { cleanPlainText, constantTimeEqual, containsMarkup, hashSecret, keyedHash, randomCode, randomToken, sha256, verifySecret } from "../lib/security.js";
import { generateTotpSecret, openTotpSecret, sealTotpSecret, verifyTotp } from "../lib/totp.js";
import type { AppStore } from "../store/store.js";

const COOKIE_NAME = "undying_admin_session";
const ADMIN_PRESENCE_WINDOW_MS = 60_000;

function adminPresence(now = new Date()) {
  return { now, activeSince: new Date(now.getTime() - ADMIN_PRESENCE_WINDOW_MS) };
}

const plainText = (minimum: number, maximum: number) =>
  z.string().transform(cleanPlainText).pipe(z.string().min(minimum).max(maximum).refine((value) => !containsMarkup(value), "HTML и скрипты запрещены"));

const loginBody = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(10).max(256),
  otp: z.union([z.string().regex(/^\d{6}$/), z.literal("")]).optional(),
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
  buyerGameId: z.string().trim().regex(/^\d{5,20}$/, "Укажите корректный PUBG ID покупателя"),
  amount: scalarText,
  currency: z.enum(["UAH", "EUR", "USD"]),
  exchangeRate: z.union([scalarText, z.literal("")]).optional().default(""),
  orderDate: orderDateValue,
  escorts: z.array(z.object({
    name: plainText(2, 64),
    gameId: z.string().trim().regex(/^\d{5,20}$/, "Укажите PUBG ID сопровождающего"),
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
const participantAssignmentBody = z.object({ status: z.enum(["invited", "accepted", "declined"]) });
const penaltyDeleteBody = z.object({ clearPaid: z.boolean().optional().default(false) });
const participantParams = z.object({ id: z.string().uuid(), participantId: z.string().uuid() });
const rateQuery = z.object({ currency: z.enum(["UAH", "EUR", "USD"]), date: orderDateValue });
const penaltyBody = z.object({ reason: plainText(3, 300) });
const replacementBody = z.object({
  name: plainText(2, 64),
  gameId: z.string().trim().regex(/^\d{5,20}$/, "Укажите PUBG ID нового игрока"),
  contact: z.union([plainText(3, 128), z.literal("")]).optional().default(""),
});
const adminRole = z.enum(["owner", "director", "admin", "observer"]);
const adminCreateBody = z.object({
  username: z.string().trim().toLowerCase().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(12).max(256),
  role: adminRole,
});
const adminUpdateBody = z.object({
  role: adminRole.optional(),
  active: z.boolean().optional(),
  password: z.string().min(12).max(256).optional(),
}).refine((value) => Object.keys(value).length > 0, "Нет изменений");
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
const profileQuery = pageQuery.extend({ query: z.string().trim().max(80).optional() });
const penaltyQuery = pageQuery.extend({ query: z.string().trim().max(120).optional() });
const reportQuery = z.object({ from: orderDateValue, to: orderDateValue });

function orderDate(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function serializeEscortOrder(order: any) {
  const orderPenaltyMinor = order.participants.reduce(
    (sum: bigint, participant: any) => sum + (participant.penalties ?? []).reduce(
      (penaltySum: bigint, penalty: any) => penaltySum + penalty.amountUahMinor,
      0n,
    ),
    0n,
  );
  return {
    id: order.id,
    item: order.item,
    buyerName: order.buyerName,
    buyerContact: order.buyerContact,
    buyerGameId: order.buyerGameId,
    reviewCodeIssuedAt: order.reviewCodeIssuedAt,
    reviewCodeConsumedAt: order.reviewCodeConsumedAt,
    originalAmount: formatMinor(order.originalAmountMinor),
    currency: order.currency,
    exchangeRate: formatRate(order.exchangeRateMicros),
    rateSource: order.rateSource,
    amountUah: formatMinor(order.amountUahMinor),
    directorAmountUah: formatMinor(order.directorAmountMinor),
    creatorAmountUah: formatMinor(order.creatorAmountMinor),
    escortPoolUah: formatMinor(order.escortPoolMinor),
    orderDate: order.orderDate,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    bankFromPenaltiesUah: formatMinor(orderPenaltyMinor),
    participants: order.participants.map((participant: any) => ({
      ...(() => {
        const penaltyTotalMinor = (participant.penalties ?? []).reduce(
          (sum: bigint, penalty: any) => sum + penalty.amountUahMinor,
          0n,
        );
        const dailyCount = participant.dailyViolationCount ?? 0;
        const nextPenalty = PENALTY_PERCENTAGES[dailyCount] ?? null;
        return {
          penaltyTotalUah: formatMinor(penaltyTotalMinor),
          payoutUah: formatMinor(participant.replacedAt ? 0n : BigInt(participant.shareUahMinor) - penaltyTotalMinor),
          dailyViolationCount: dailyCount,
          nextPenaltyPercent: dailyCount < 4 ? nextPenalty : null,
          nextViolationAction: dailyCount < 4 ? "penalty" : dailyCount === 4 ? "permanent_ban" : null,
        };
      })(),
      id: participant.id,
      name: participant.name,
      contact: participant.contact,
      playerGameId: participant.playerProfile?.gameId ?? null,
      playerProfileId: participant.playerProfileId,
      suspendedUntil: participant.playerProfile?.suspendedUntil ?? null,
      permanentlyBanned: participant.playerProfile?.permanentlyBanned ?? false,
      shareUah: formatMinor(participant.shareUahMinor),
      active: participant.active,
      paid: participant.paid,
      assignmentStatus: participant.assignmentStatus,
      paidAt: participant.paidAt,
      replacedAt: participant.replacedAt,
      excludedAt: participant.excludedAt,
      replacementForId: participant.replacementForId,
      penalties: (participant.penalties ?? []).map((penalty: any) => ({
        id: penalty.id,
        sequence: penalty.sequence,
        violationDate: penalty.violationDate,
        percentage: penalty.percentage,
        amountUah: formatMinor(penalty.amountUahMinor),
        reason: penalty.reason,
        createdAt: penalty.createdAt,
      })),
    })),
  };
}

function serializePlayerProfile(profile: any) {
  return {
    id: profile.id,
    gameId: profile.gameId,
    displayName: profile.displayName,
    contact: profile.contact,
    suspendedUntil: profile.suspendedUntil,
    permanentlyBanned: profile.permanentlyBanned,
    bannedAt: profile.bannedAt,
    orderCount: profile.orderCount ?? 0,
    penaltyCount: profile.penaltyCount ?? 0,
    earnedUah: formatMinor(profile.earnedUahMinor ?? 0n),
    withheldUah: formatMinor(profile.withheldUahMinor ?? 0n),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function serializeFinancial(summary: any) {
  return {
    from: summary.from,
    to: summary.to,
    orderCount: summary.orderCount,
    grossUah: formatMinor(summary.grossUahMinor),
    directorUah: formatMinor(summary.directorUahMinor),
    creatorUah: formatMinor(summary.creatorUahMinor),
    escortPoolUah: formatMinor(summary.escortPoolUahMinor),
    penaltiesUah: formatMinor(summary.penaltiesUahMinor),
    paidToEscortsUah: formatMinor(summary.paidToEscortsUahMinor),
    unpaidToEscortsUah: formatMinor(summary.unpaidToEscortsUahMinor),
  };
}

function serializePenalty(penalty: any) {
  return {
    id: penalty.id,
    participantId: penalty.participantId,
    playerProfileId: penalty.playerProfileId,
    participantName: penalty.participantName,
    playerGameId: penalty.playerGameId,
    orderId: penalty.orderId,
    orderItem: penalty.orderItem,
    buyerName: penalty.buyerName,
    sequence: penalty.sequence,
    violationDate: penalty.violationDate,
    percentage: penalty.percentage,
    amountUah: formatMinor(penalty.amountUahMinor),
    reason: penalty.reason,
    createdByUsername: penalty.createdByUsername,
    createdAt: penalty.createdAt,
  };
}

function serializeAdmin(admin: any) {
  const { passwordHash: _passwordHash, twoFactorSecret: _twoFactorSecret, ...safe } = admin;
  return safe;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function sessionCookie(request: FastifyRequest): string {
  const signed = request.cookies[COOKIE_NAME];
  if (!signed) return "";
  const result = request.unsignCookie(signed);
  return result.valid ? result.value : "";
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: { store: AppStore; config: AppConfig; notifier: AdminNotifier },
): Promise<void> {
  const { store, config, notifier } = dependencies;

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const rawToken = sessionCookie(request);
    if (!rawToken) return reply.code(401).send({ error: "Требуется вход администратора" });
    const session = await store.refreshAdminSession(sha256(rawToken), adminPresence());
    if (!session) {
      return reply.code(401).send({ error: "Сессия истекла" });
    }
    request.adminAuth = { admin: session.admin, session, accessMode: session.accessMode };
  };

  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.adminAuth) return reply.code(401).send({ error: "Требуется вход администратора" });
    const header = request.headers["x-csrf-token"];
    const token = typeof header === "string" ? header : "";
    if (!token || !constantTimeEqual(token, request.adminAuth.session.csrfToken)) {
      return reply.code(403).send({ error: "Недействительный CSRF-токен" });
    }
  };

  const requireOperator = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.adminAuth) return reply.code(401).send({ error: "Требуется вход администратора" });
    if (request.adminAuth.accessMode !== "operator" || request.adminAuth.admin.role === "observer") {
      return reply.code(403).send({
        code: "ADMIN_READ_ONLY",
        error: "Панель открыта в режиме наблюдения. Изменения может вносить только первый активный администратор.",
      });
    }
  };

  const requireOwner = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.adminAuth) return reply.code(401).send({ error: "Требуется вход администратора" });
    if (request.adminAuth.admin.role !== "owner") {
      return reply.code(403).send({ error: "Только владелец может управлять аккаунтами" });
    }
  };

  const audit = (request: FastifyRequest, action: string, entityType: string, entityId?: string | null, details?: Record<string, unknown>) =>
    store.createAuditLog({ adminId: request.adminAuth?.admin.id ?? null, action, entityType, entityId, details });

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
      if (admin.twoFactorEnabled) {
        if (!parsed.data.otp) return reply.code(401).send({ code: "OTP_REQUIRED", error: "Введите шестизначный код 2FA" });
        const secret = admin.twoFactorSecret ? openTotpSecret(admin.twoFactorSecret, config.cookieSecret) : "";
        if (!secret || !verifyTotp(secret, parsed.data.otp)) return reply.code(401).send({ code: "OTP_INVALID", error: "Неверный код 2FA" });
      }

      const presence = adminPresence();
      const existingToken = sessionCookie(request);
      if (existingToken) {
        const existing = await store.refreshAdminSession(sha256(existingToken), presence);
        if (existing?.admin.id === admin.id) {
          return {
            admin: { id: admin.id, username: admin.username, role: admin.role },
            csrfToken: existing.csrfToken,
            expiresAt: existing.expiresAt,
            accessMode: existing.accessMode,
            canWrite: existing.accessMode === "operator" && admin.role !== "observer",
          };
        }
        if (existing) await store.deleteAdminSession(sha256(existingToken), presence);
      }
      const rawToken = randomToken();
      const csrfToken = randomToken(24);
      const expiresAt = new Date(presence.now.getTime() + config.sessionTtlHours * 60 * 60 * 1000);
      const session = await store.createAdminSession(
        { tokenHash: sha256(rawToken), csrfToken, adminId: admin.id, expiresAt },
        presence,
      );
      reply.setCookie(COOKIE_NAME, rawToken, {
        path: "/",
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        signed: true,
        expires: expiresAt,
      });
      return {
        admin: { id: admin.id, username: admin.username, role: admin.role },
        csrfToken,
        expiresAt,
        accessMode: session.accessMode,
        canWrite: session.accessMode === "operator" && admin.role !== "observer",
      };
    },
  );

  app.post("/api/admin/logout", { preHandler: [requireAdmin, requireCsrf] }, async (request, reply) => {
    const token = sessionCookie(request);
    if (token) await store.deleteAdminSession(sha256(token), adminPresence());
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { success: true };
  });

  app.get("/api/admin/dashboard", { preHandler: requireAdmin }, async (request) => ({
    admin: { id: request.adminAuth!.admin.id, username: request.adminAuth!.admin.username, role: request.adminAuth!.admin.role },
    csrfToken: request.adminAuth!.session.csrfToken,
    accessMode: request.adminAuth!.accessMode,
    canWrite: request.adminAuth!.accessMode === "operator" && request.adminAuth!.admin.role !== "observer",
    counts: await store.dashboardCounts(),
  }));

  app.get("/api/admin/accounts", { preHandler: [requireAdmin, requireOwner] }, async () => ({
    items: (await store.listAdmins()).map(serializeAdmin),
  }));

  app.post("/api/admin/accounts", { preHandler: [requireAdmin, requireCsrf, requireOperator, requireOwner] }, async (request, reply) => {
    const body = adminCreateBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Проверьте данные аккаунта" });
    try {
      const admin = await store.createAdmin(body.data.username, await hashSecret(body.data.password), body.data.role);
      await audit(request, "admin.created", "admin", admin.id, { username: admin.username, role: admin.role });
      return reply.code(201).send(serializeAdmin(admin));
    } catch {
      return reply.code(409).send({ error: "Администратор с таким логином уже существует" });
    }
  });

  app.patch("/api/admin/accounts/:id", { preHandler: [requireAdmin, requireCsrf, requireOperator, requireOwner] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = adminUpdateBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте изменения аккаунта" });
    if (params.data.id === request.adminAuth!.admin.id && (body.data.active === false || (body.data.role && body.data.role !== "owner"))) {
      return reply.code(409).send({ error: "Нельзя отключить собственный аккаунт владельца или снять с него роль" });
    }
    const admins = await store.listAdmins();
    const target = admins.find((admin) => admin.id === params.data.id);
    if (!target) return reply.code(404).send({ error: "Аккаунт не найден" });
    if (target.role === "owner" && (body.data.active === false || (body.data.role && body.data.role !== "owner"))) {
      const activeOwners = admins.filter((admin) => admin.active && admin.role === "owner");
      if (activeOwners.length <= 1) return reply.code(409).send({ error: "Нельзя отключить или понизить последнего владельца" });
    }
    const admin = await store.updateAdmin(params.data.id, {
      role: body.data.role,
      active: body.data.active,
      passwordHash: body.data.password ? await hashSecret(body.data.password) : undefined,
    });
    if (!admin) return reply.code(404).send({ error: "Аккаунт не найден" });
    await audit(request, "admin.updated", "admin", admin.id, { role: body.data.role, active: body.data.active, passwordChanged: Boolean(body.data.password) });
    return serializeAdmin(admin);
  });

  app.post("/api/admin/accounts/:id/2fa/setup", { preHandler: [requireAdmin, requireCsrf, requireOperator, requireOwner] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный ID аккаунта" });
    const target = (await store.listAdmins()).find((admin) => admin.id === params.data.id);
    if (!target) return reply.code(404).send({ error: "Аккаунт не найден" });
    const secret = generateTotpSecret();
    await store.updateAdmin(target.id, { twoFactorSecret: sealTotpSecret(secret, config.cookieSecret), twoFactorEnabled: false });
    await audit(request, "admin.2fa_setup_started", "admin", target.id);
    return { secret, otpauthUri: `otpauth://totp/Undying%20Metro:${encodeURIComponent(target.username)}?secret=${secret}&issuer=Undying%20Metro` };
  });

  app.post("/api/admin/accounts/:id/2fa/confirm", { preHandler: [requireAdmin, requireCsrf, requireOperator, requireOwner] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Введите шестизначный код" });
    const target = (await store.listAdmins()).find((admin) => admin.id === params.data.id);
    if (!target?.twoFactorSecret || !verifyTotp(openTotpSecret(target.twoFactorSecret, config.cookieSecret), body.data.code)) return reply.code(400).send({ error: "Неверный код 2FA" });
    const updated = await store.updateAdmin(target.id, { twoFactorEnabled: true });
    await audit(request, "admin.2fa_enabled", "admin", target.id);
    return serializeAdmin(updated);
  });

  app.delete("/api/admin/accounts/:id/2fa", { preHandler: [requireAdmin, requireCsrf, requireOperator, requireOwner] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный ID аккаунта" });
    const updated = await store.updateAdmin(params.data.id, { twoFactorSecret: null, twoFactorEnabled: false });
    if (!updated) return reply.code(404).send({ error: "Аккаунт не найден" });
    await audit(request, "admin.2fa_disabled", "admin", updated.id);
    return serializeAdmin(updated);
  });

  app.get("/api/admin/player-profiles", { preHandler: requireAdmin }, async (request, reply) => {
    const query = profileQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Некорректные параметры" });
    const page = await store.listEscortPlayerProfiles(query.data.query, query.data.page, query.data.pageSize);
    return { ...page, items: page.items.map(serializePlayerProfile) };
  });

  app.get("/api/admin/player-profiles/:id", { preHandler: requireAdmin }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный ID" });
    const profile = await store.getEscortPlayerProfile(params.data.id);
    return profile ? serializePlayerProfile(profile) : reply.code(404).send({ error: "Профиль не найден" });
  });

  app.get("/api/admin/audit-logs", { preHandler: requireAdmin }, async (request, reply) => {
    const query = pageQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Некорректные параметры" });
    return store.listAuditLogs(query.data.page, query.data.pageSize);
  });

  app.get("/api/admin/reports/financial", { preHandler: requireAdmin }, async (request, reply) => {
    const query = reportQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Укажите период отчёта" });
    const from = orderDate(query.data.from)!;
    const to = orderDate(query.data.to)!;
    if (from > to) return reply.code(400).send({ error: "Начало периода должно быть раньше конца" });
    return serializeFinancial(await store.financialSummary(from, to));
  });

  app.get("/api/admin/reports/financial.csv", { preHandler: requireAdmin }, async (request, reply) => {
    const query = reportQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Укажите период отчёта" });
    const from = orderDate(query.data.from)!;
    const to = orderDate(query.data.to)!;
    if (from > to) return reply.code(400).send({ error: "Начало периода должно быть раньше конца" });
    const data = serializeFinancial(await store.financialSummary(from, to));
    const rows = [
      ["Период с", query.data.from], ["Период по", query.data.to], ["Заказов", data.orderCount],
      ["Оборот UAH", data.grossUah], ["Директор UAH", data.directorUah], ["Создатель UAH", data.creatorUah],
      ["Фонд сопровождающих UAH", data.escortPoolUah], ["Штрафы UAH", data.penaltiesUah],
      ["Выплачено сопровождающим UAH", data.paidToEscortsUah], ["Не выплачено сопровождающим UAH", data.unpaidToEscortsUah],
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="financial-${query.data.from}-${query.data.to}.csv"`).send(csv);
  });

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

  app.get("/api/admin/shop-bank", { preHandler: requireAdmin }, async () => {
    const [penaltyBalance, directorBalance, creatorBalance] = await Promise.all([
      store.getShopBankBalance(),
      store.getDirectorBankBalance(),
      store.getCreatorBankBalance(),
    ]);
    return {
      currency: "UAH",
      balanceUah: formatMinor(penaltyBalance),
      penaltyBalanceUah: formatMinor(penaltyBalance),
      directorBalanceUah: formatMinor(directorBalance),
      creatorBalanceUah: formatMinor(creatorBalance),
    };
  });

  app.post("/api/admin/escort-orders", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
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
      const reviewCode = randomCode(10);
      const issuedAt = new Date();
      const order = await store.createEscortOrder({
        item: parsed.data.item,
        buyerName: parsed.data.buyerName,
        buyerContact: parsed.data.buyerContact || null,
        buyerGameId: parsed.data.buyerGameId,
        reviewCodeHash: keyedHash(reviewCode, config.reviewCodePepper),
        reviewCodeIssuedAt: issuedAt,
        originalAmountMinor,
        currency: parsed.data.currency,
        exchangeRateMicros,
        rateSource,
        amountUahMinor: calculation.amountUahMinor,
        developerAmountMinor: 0n,
        directorAmountMinor: calculation.directorAmountMinor,
        creatorAmountMinor: calculation.creatorAmountMinor,
        escortPoolMinor: calculation.escortPoolMinor,
        orderDate: date,
        createdById: request.adminAuth!.admin.id,
        participants: parsed.data.escorts.map((escort, index) => ({
          name: escort.name,
          gameId: escort.gameId,
          contact: escort.contact || null,
          shareUahMinor: calculation.shares[index]!,
        })),
      });
      await audit(request, "escort_order.created", "escort_order", order.id, { buyerGameId: parsed.data.buyerGameId });
      await notifier.operation("escort_order_created", ["🛒 Новое сопровождение", `Покупатель: ${order.buyerName}`, `Позиция: ${order.item}`, `Сумма: ${formatMinor(order.amountUahMinor)} UAH`]);
      return reply.code(201).send({ ...serializeEscortOrder(order), reviewCode });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось рассчитать сопровождение";
      return reply.code(message.includes("НБУ") ? 503 : 400).send({ error: message });
    }
  });

  app.patch("/api/admin/escort-orders/:id/status", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = escortStatusBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте статус" });
    const order = await store.updateEscortOrderStatus(params.data.id, body.data.status);
    if (order) await audit(request, "escort_order.status_changed", "escort_order", order.id, { status: body.data.status });
    if (order) await notifier.operation("escort_order_status", ["📦 Статус сопровождения изменён", `Покупатель: ${order.buyerName}`, `Статус: ${body.data.status}`]);
    return order ? serializeEscortOrder(order) : reply.code(404).send({ error: "Сопровождение не найдено" });
  });

  app.get("/api/admin/penalties", { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = penaltyQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Некорректные параметры" });
    const page = await store.listEscortPenalties(parsed.data.query, parsed.data.page, parsed.data.pageSize);
    return { ...page, items: page.items.map(serializePenalty) };
  });

  app.delete("/api/admin/penalties/:id", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = penaltyDeleteBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: "Некорректные данные удаления штрафа" });
    try {
      const penalty = await store.deleteEscortPenalty(params.data.id, body.data.clearPaid);
      if (!penalty) return reply.code(404).send({ error: "Штраф не найден" });
      await audit(request, "escort_penalty.deleted", "escort_penalty", penalty.id, {
        playerGameId: penalty.playerGameId,
        participantName: penalty.participantName,
        orderId: penalty.orderId,
        percentage: penalty.percentage,
        amountUah: formatMinor(penalty.amountUahMinor),
        reason: penalty.reason,
        paymentCleared: body.data.clearPaid,
      });
      return { deletedId: penalty.id };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Не удалось удалить штраф" });
    }
  });

  app.post("/api/admin/escort-orders/:id/review-code", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный ID" });
    const reviewCode = randomCode(10);
    try {
      const order = await store.rotateEscortReviewCode(params.data.id, keyedHash(reviewCode, config.reviewCodePepper), new Date());
      if (!order) return reply.code(404).send({ error: "Сопровождение не найдено" });
      await audit(request, "escort_order.review_code_rotated", "escort_order", order.id);
      return { ...serializeEscortOrder(order), reviewCode };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Не удалось обновить код" });
    }
  });

  app.patch("/api/admin/escort-orders/:id/participants/:participantId", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = participantParams.safeParse(request.params);
    const body = participantPaidBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте данные выплаты" });
    try {
      const order = await store.updateEscortParticipantPaid(params.data.id, params.data.participantId, body.data.paid);
      const participant = order?.participants.find((item) => item.id === params.data.participantId);
      const withheld = participant?.penalties.reduce((sum, penalty) => sum + penalty.amountUahMinor, 0n) ?? 0n;
      const payout = participant ? participant.shareUahMinor - withheld : 0n;
      if (order) await audit(request, "escort_participant.payment_changed", "escort_participant", params.data.participantId, { paid: body.data.paid, orderId: params.data.id, participantName: participant?.name, payoutUah: formatMinor(payout) });
      if (order && participant) await notifier.operation("escort_payment_changed", [body.data.paid ? "💸 Выплата отмечена" : "↩️ Выплата отменена", `Игрок: ${participant.name}`, `Сумма: ${formatMinor(payout)} UAH`]);
      return order ? serializeEscortOrder(order) : reply.code(404).send({ error: "Игрок или сопровождение не найдено" });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Не удалось изменить выплату" });
    }
  });

  app.patch("/api/admin/escort-orders/:id/participants/:participantId/assignment", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = participantParams.safeParse(request.params);
    const body = participantAssignmentBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте статус назначения" });
    const order = await store.updateEscortParticipantAssignment(params.data.id, params.data.participantId, body.data.status);
    if (!order) return reply.code(404).send({ error: "Игрок или сопровождение не найдено" });
    const participant = order.participants.find((item) => item.id === params.data.participantId);
    await audit(request, "escort_participant.assignment_changed", "escort_participant", params.data.participantId, { orderId: params.data.id, status: body.data.status, participantName: participant?.name });
    await notifier.operation("escort_assignment_changed", ["👥 Назначение обновлено", `Игрок: ${participant?.name ?? "неизвестно"}`, `Статус: ${body.data.status}`]);
    return serializeEscortOrder(order);
  });

  app.post("/api/admin/escort-orders/:id/participants/:participantId/penalties", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = participantParams.safeParse(request.params);
    const body = penaltyBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Укажите причину штрафа" });
    try {
      const order = await store.penalizeEscortParticipant(
        params.data.id,
        params.data.participantId,
        body.data.reason,
        request.adminAuth!.admin.id,
      );
      if (order) await audit(request, "escort_participant.violation_added", "escort_participant", params.data.participantId, { orderId: params.data.id, reason: body.data.reason });
      const participant = order?.participants.find((item) => item.id === params.data.participantId);
      if (order && participant) await notifier.operation("escort_penalty_created", ["⚠️ Новый штраф", `Игрок: ${participant.name}`, `Причина: ${body.data.reason}`]);
      return order ? serializeEscortOrder(order) : reply.code(404).send({ error: "Игрок или сопровождение не найдено" });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Не удалось применить штраф" });
    }
  });

  app.post("/api/admin/escort-orders/:id/participants/:participantId/replacement", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = participantParams.safeParse(request.params);
    const body = replacementBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте данные нового игрока" });
    try {
      const order = await store.replaceEscortParticipant(params.data.id, params.data.participantId, {
        name: body.data.name,
        gameId: body.data.gameId,
        contact: body.data.contact || null,
      });
      if (order) await audit(request, "escort_participant.replaced", "escort_participant", params.data.participantId, { orderId: params.data.id, replacementGameId: body.data.gameId });
      return order ? serializeEscortOrder(order) : reply.code(404).send({ error: "Игрок или сопровождение не найдено" });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Не удалось заменить игрока" });
    }
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

  app.patch("/api/admin/reviews/:id", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = reviewUpdate.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте данные модерации" });
    const review = await store.updateReview(params.data.id, {
      status: body.data.status,
      adminReply: body.data.adminReply || null,
      moderatedById: request.adminAuth!.admin.id,
    });
    if (!review) return reply.code(404).send({ error: "Отзыв не найден" });
    await audit(request, "review.moderated", "review", review.id, { status: body.data.status });
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

  app.post("/api/admin/tickets/:id/messages", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = messageBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте сообщение" });
    const ticket = await store.findTicketById(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Обращение не найдено" });
    if (ticket.status === "closed") return reply.code(409).send({ error: "Обращение закрыто" });
    const message = await store.addTicketMessage(ticket.id, "admin", body.data.message, request.adminAuth!.admin.id);
    await audit(request, "support.message_sent", "support_ticket", ticket.id);
    return reply.code(201).send(message);
  });

  app.patch("/api/admin/tickets/:id/status", { preHandler: [requireAdmin, requireCsrf, requireOperator] }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = ticketStatusBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "Проверьте статус" });
    const ticket = await store.updateTicketStatus(params.data.id, body.data.status, request.adminAuth!.admin.id);
    if (!ticket) return reply.code(404).send({ error: "Обращение не найдено" });
    await audit(request, "support.status_changed", "support_ticket", ticket.id, { status: body.data.status });
    const { secretTokenHash: _secret, ipHash: _ip, ...safeTicket } = ticket;
    return safeTicket;
  });
}
