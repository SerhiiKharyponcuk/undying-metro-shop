import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AdminNotifier } from "../src/lib/telegram.js";
import { hashSecret, keyedHash } from "../src/lib/security.js";
import { sealTotpSecret, totpCode } from "../src/lib/totp.js";
import type { ReviewRecord, SupportMessageRecord, SupportTicketRecord } from "../src/types/domain.js";
import { MemoryStore } from "./memory-store.js";

class RecordingNotifier implements AdminNotifier {
  reviews: string[] = [];
  tickets: string[] = [];
  messages: string[] = [];
  operations: string[] = [];
  async review(review: ReviewRecord) { this.reviews.push(review.id); }
  async ticket(ticket: SupportTicketRecord) { this.tickets.push(ticket.id); }
  async ticketMessage(ticket: SupportTicketRecord, message: SupportMessageRecord) { this.messages.push(`${ticket.id}:${message.id}`); }
  async operation(eventType: string) { this.operations.push(eventType); }
}

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 10000,
  databaseUrl: "postgresql://test:test@localhost:5432/test",
  corsOrigins: ["https://example.test"],
  cookieSecret: "c".repeat(40),
  ticketTokenPepper: "t".repeat(40),
  reviewCodePepper: "r".repeat(40),
  ipHashSalt: "i".repeat(40),
  sessionTtlHours: 24,
  turnstileRequired: false,
  turnstileSecretKey: "",
  telegramBotToken: "",
  telegramAdminChatIds: ["123"],
  telegramWebhookSecret: "w".repeat(32),
  adminPanelUrl: "https://example.test/admin/",
};

describe("Undying Metro API", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let notifier: RecordingNotifier;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    await store.createAdmin("admin", await hashSecret("very-secure-password"), "owner");
    app = await buildApp({ config, store, notifier, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const reviewPayload = (text = "Отличный магазин и быстрая помощь", buyerGameId = "1234567890") => ({
    name: "Сергей",
    contact: "@serhii_test",
    buyerGameId,
    reviewCode: "ABCDEFGH23",
    rating: 5,
    text,
    turnstileToken: "",
  });

  const ticketPayload = () => ({
    name: "Сергей",
    contactType: "telegram",
    contact: "@serhii_test",
    category: "purchase",
    subject: "Вопрос о покупке",
    message: "Подскажите, пожалуйста, доступен ли выбранный товар?",
    turnstileToken: "",
  });

  async function login() {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { username: "admin", password: "very-secure-password" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const cookie = String(response.headers["set-cookie"]).split(";")[0];
    return { cookie, csrf: body.csrfToken, sessionToken: body.sessionToken as string, accessMode: body.accessMode as "operator" | "observer" };
  }

  async function seedCompletedPurchase(buyerGameId = "1234567890") {
    const order = await store.createEscortOrder({
      item: "Проверенная покупка",
      buyerName: "Покупатель",
      buyerContact: null,
      buyerGameId,
      reviewCodeHash: keyedHash("ABCDEFGH23", config.reviewCodePepper),
      reviewCodeIssuedAt: new Date(),
      originalAmountMinor: 0n,
      currency: "UAH",
      exchangeRateMicros: 1_000_000n,
      rateSource: "uah",
      amountUahMinor: 0n,
      developerAmountMinor: 0n,
      directorAmountMinor: 0n,
      creatorAmountMinor: 0n,
      escortPoolMinor: 0n,
      orderDate: new Date("2026-07-19T00:00:00.000Z"),
      createdById: store.admins[0]!.id,
      participants: [{ name: "Сопровождающий", gameId: "7000000001", contact: null, shareUahMinor: 0n }],
    });
    await store.updateEscortOrderStatus(order.id, "completed");
    return order;
  }

  it("показывает дружелюбный статус на корневом адресе API", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "Undying Metro Shop API" });
  });

  it("раздаёт админ-панель с того же HTTPS origin, что и API", async () => {
    const redirect = await app.inject({ method: "GET", url: "/admin" });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("/admin/");

    const page = await app.inject({ method: "GET", url: "/admin/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("id=\"loginForm\"");

    const runtimeConfig = await app.inject({ method: "GET", url: "/config.js" });
    expect(runtimeConfig.statusCode).toBe(200);
    expect(runtimeConfig.body).toContain("API_BASE_URL: window.location.origin");
  });

  it("показывает двух свободных менеджеров и фиксирует занятость на 3 минуты", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/managers" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().holdSeconds).toBe(3 * 60);
    expect(initial.json().items).toEqual([
      { key: "manager_1", status: "available", busyUntil: null },
      { key: "manager_2", status: "available", busyUntil: null },
    ]);

    const claimed = await app.inject({ method: "POST", url: "/api/managers/manager_1/claim" });
    expect(claimed.statusCode).toBe(201);
    const remaining = new Date(claimed.json().busyUntil).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(2 * 60 * 1000);
    expect(remaining).toBeLessThanOrEqual(3 * 60 * 1000);

    const status = await app.inject({ method: "GET", url: "/api/managers" });
    expect(status.json().items[0].status).toBe("busy");
    expect(status.json().items[1].status).toBe("available");
  });

  it("не позволяет двум посетителям одновременно занять одного менеджера", async () => {
    expect((await app.inject({ method: "POST", url: "/api/managers/manager_2/claim" })).statusCode).toBe(201);
    const repeated = await app.inject({ method: "POST", url: "/api/managers/manager_2/claim" });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().status).toBe("busy");
    expect((await app.inject({ method: "POST", url: "/api/managers/unknown/claim" })).statusCode).toBe(400);

    store.managerAvailability.set("manager_2", new Date(Date.now() - 1000));
    expect((await app.inject({ method: "POST", url: "/api/managers/manager_2/claim" })).statusCode).toBe(201);
  });

  it("создаёт отзыв со статусом pending и отправляет уведомление", async () => {
    await seedCompletedPurchase();
    const response = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("pending");
    expect(store.reviews).toHaveLength(1);
    expect(store.reviews[0]).toMatchObject({ buyerGameId: "1234567890", escortOrderId: store.escortOrders[0]!.id });
    expect(notifier.reviews).toEqual([store.reviews[0]!.id]);

    const publicReviews = await app.inject({ method: "GET", url: "/api/reviews" });
    expect(publicReviews.json().items).toHaveLength(0);
  });

  it("отклоняет XSS и неправильные данные", async () => {
    const xss = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("<script>alert(1)</script>") });
    expect(xss.statusCode).toBe(400);
    const invalid = await app.inject({ method: "POST", url: "/api/reviews", payload: { ...reviewPayload("коротко"), rating: 9 } });
    expect(invalid.statusCode).toBe(400);
    const invalidId = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Хороший сервис и быстрая помощь", "abc") });
    expect(invalidId.statusCode).toBe(400);
  });

  it("разрешает отзыв только по PUBG ID и одноразовому коду завершённого заказа", async () => {
    const unknownId = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Хороший сервис и быстрая помощь", "9999999999") });
    expect(unknownId.statusCode).toBe(403);
    expect(unknownId.json().error).toContain("PUBG ID");

    await seedCompletedPurchase("9999999999");
    const wrongCode = await app.inject({ method: "POST", url: "/api/reviews", payload: { ...reviewPayload("Другой хороший отзыв для проверки", "9999999999"), reviewCode: "ZZZZZZZZZZ" } });
    expect(wrongCode.statusCode).toBe(403);
    const verified = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Хороший сервис и быстрая помощь", "9999999999") });
    expect(verified.statusCode).toBe(201);
  });

  it("не принимает повтор одного отзыва", async () => {
    await seedCompletedPurchase();
    expect((await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() })).statusCode).toBe(409);
  });

  it("ограничивает частую отправку отзывов", async () => {
    await Promise.all([seedCompletedPurchase(), seedCompletedPurchase(), seedCompletedPurchase()]);
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload(`Уникальный хороший отзыв номер ${index}`) });
      expect(response.statusCode).toBe(201);
    }
    const limited = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Четвёртый уникальный хороший отзыв") });
    expect(limited.statusCode).toBe(429);
  });

  it("требует 2FA и устанавливает Safari-совместимую cookie", async () => {
    const admin = store.admins[0]!;
    const secret = "JBSWY3DPEHPK3PXP";
    await store.updateAdmin(admin.id, { twoFactorSecret: sealTotpSecret(secret, config.cookieSecret), twoFactorEnabled: true });
    const challenge = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "admin", password: "very-secure-password" } });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.json()).toMatchObject({ code: "OTP_REQUIRED" });
    const accepted = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "admin", password: "very-secure-password", otp: totpCode(secret) } });
    expect(accepted.statusCode).toBe(200);
    expect(String(accepted.headers["set-cookie"])).toContain("Path=/");
    expect(String(accepted.headers["set-cookie"])).toContain("SameSite=Lax");
  });

  it("keeps an admin session through a bearer token when cookies are unavailable", async () => {
    const authenticated = await login();
    expect(authenticated.sessionToken).toBeTruthy();

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { authorization: `Bearer ${authenticated.sessionToken}` },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({ canWrite: true });

    const logout = await app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: {
        authorization: `Bearer ${authenticated.sessionToken}`,
        "x-csrf-token": authenticated.csrf,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);

    const expired = await app.inject({
      method: "GET",
      url: "/api/admin/dashboard",
      headers: { authorization: `Bearer ${authenticated.sessionToken}` },
    });
    expect(expired.statusCode).toBe(401);
  });

  it("opens protected player and buyer portals and processes a penalty appeal", async () => {
    const order = await seedCompletedPurchase();
    const auth = await login();
    const participant = order.participants[0]!;
    const profile = store.playerProfiles.find((item) => item.id === participant.playerProfileId)!;

    const accessCode = await app.inject({
      method: "POST",
      url: `/api/admin/player-profiles/${profile.id}/portal-code`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: {},
    });
    expect(accessCode.statusCode).toBe(200);

    const penalty = await app.inject({
      method: "POST",
      url: `/api/admin/escort-orders/${order.id}/participants/${participant.id}/penalties`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { reason: "Тестове порушення правил супроводу" },
    });
    expect(penalty.statusCode).toBe(200);

    const portal = await app.inject({
      method: "GET",
      url: `/api/escort-portal/${profile.gameId}`,
      headers: { "x-player-code": accessCode.json().code },
    });
    expect(portal.statusCode).toBe(200);
    expect(portal.json().orders[0].penalties).toHaveLength(1);

    const appeal = await app.inject({
      method: "POST",
      url: `/api/escort-portal/${profile.gameId}/appeals`,
      headers: { "x-player-code": accessCode.json().code },
      payload: { penaltyId: portal.json().orders[0].penalties[0].id, message: "Прошу переглянути штраф, бо маю підтвердження." },
    });
    expect(appeal.statusCode).toBe(201);

    const reviewAppeal = await app.inject({
      method: "PATCH",
      url: `/api/admin/penalty-appeals/${appeal.json().id}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { status: "approved", adminReply: "Оскарження прийнято до перевірки." },
    });
    expect(reviewAppeal.statusCode).toBe(200);

    const buyer = await app.inject({ method: "POST", url: "/api/orders/lookup", payload: { gameId: "1234567890", code: "ABCDEFGH23" } });
    expect(buyer.statusCode).toBe(200);
    expect(buyer.json()).toMatchObject({ status: "completed" });
  });

  it("provides readiness, backups, and Passkey registration options", async () => {
    await seedCompletedPurchase();
    const auth = await login();
    const readiness = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ status: "ready", database: "ok" });

    const backup = await app.inject({ method: "GET", url: "/api/admin/backups/latest", headers: { cookie: auth.cookie } });
    expect(backup.statusCode).toBe(200);
    expect(backup.json()).toMatchObject({ version: 1 });
    store.escortOrders = [];
    const restored = await app.inject({
      method: "POST",
      url: "/api/admin/backups/restore",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { confirmation: "RESTORE", backup: backup.json() },
    });
    expect(restored.statusCode).toBe(200);
    expect(store.escortOrders).toHaveLength(1);

    const options = await app.inject({
      method: "POST",
      url: "/api/admin/passkeys/registration-options",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: {},
    });
    expect(options.statusCode).toBe(200);
    expect(options.json().challenge).toBeTruthy();
    expect(options.json().rp.id).toBe("example.test");
  });

  it("clears test escort orders and payment history for owners", async () => {
    const order = await seedCompletedPurchase();
    const auth = await login();
    const participant = order.participants[0]!;
    await app.inject({
      method: "PATCH",
      url: `/api/admin/escort-orders/${order.id}/participants/${participant.id}`,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { paid: true, method: "card", note: "test payout" },
    });
    expect(store.escortOrders).toHaveLength(1);
    expect(store.auditLogs.some((item) => item.action === "escort_participant.payment_changed")).toBe(true);

    const rejected = await app.inject({
      method: "DELETE",
      url: "/api/admin/escort-operations",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { confirmation: "DELETE" },
    });
    expect(rejected.statusCode).toBe(400);

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/admin/escort-operations",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { confirmation: "DELETE TEST ORDERS" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().cleared.orders).toBe(1);
    expect(store.escortOrders).toHaveLength(0);
    expect(store.auditLogs.some((item) => item.action === "escort_participant.payment_changed")).toBe(false);
  });

  it("accepts protected Telegram commands for order status", async () => {
    const order = await seedCompletedPurchase();
    const response = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
      payload: { message: { chat: { id: 123 }, text: `/status ${order.id.slice(0, 8)} paid` } },
    });
    expect(response.statusCode).toBe(200);
    expect(store.escortOrders[0]?.status).toBe("paid");
    expect(store.auditLogs.some((item) => item.action === "telegram.order_status")).toBe(true);
  });

  it("пускает второго администратора в режим наблюдения и передаёт ему управление после выхода первого", async () => {
    const first = await login();
    const second = await login();
    expect(first.accessMode).toBe("operator");
    expect(second.accessMode).toBe("observer");

    const observerDashboard = await app.inject({ method: "GET", url: "/api/admin/dashboard", headers: { cookie: second.cookie } });
    expect(observerDashboard.statusCode).toBe(200);
    expect(observerDashboard.json()).toMatchObject({ accessMode: "observer", canWrite: false });
    const observerReads = await Promise.all([
      "/api/admin/reviews?status=&page=1&pageSize=50",
      "/api/admin/tickets?status=&query=&page=1&pageSize=50",
      "/api/admin/escort-orders?status=&page=1&pageSize=50",
      "/api/admin/shop-bank",
    ].map((url) => app.inject({ method: "GET", url, headers: { cookie: second.cookie } })));
    expect(observerReads.every((response) => response.statusCode === 200)).toBe(true);

    await seedCompletedPurchase();
    const review = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() });
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/admin/reviews/${review.json().id}`,
      headers: { cookie: second.cookie, "x-csrf-token": second.csrf },
      payload: { status: "approved", adminReply: "Ответ наблюдателя" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "ADMIN_READ_ONLY" });
    expect(store.reviews[0]?.status).toBe("pending");

    const logout = await app.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: { cookie: first.cookie, "x-csrf-token": first.csrf },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);

    const promotedDashboard = await app.inject({ method: "GET", url: "/api/admin/dashboard", headers: { cookie: second.cookie } });
    expect(promotedDashboard.json()).toMatchObject({ accessMode: "operator", canWrite: true });
    const allowed = await app.inject({
      method: "PATCH",
      url: `/api/admin/reviews/${review.json().id}`,
      headers: { cookie: second.cookie, "x-csrf-token": second.csrf },
      payload: { status: "approved", adminReply: "Ответ оператора" },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("передаёт управление активному наблюдателю, когда оператор перестаёт отправлять heartbeat", async () => {
    const first = await login();
    const second = await login();
    const operator = store.sessions.find((item) => item.accessMode === "operator");
    expect(operator).toBeTruthy();
    operator!.lastSeenAt = new Date(Date.now() - 61_000);

    const promoted = await app.inject({ method: "GET", url: "/api/admin/dashboard", headers: { cookie: second.cookie } });
    expect(promoted.json()).toMatchObject({ accessMode: "operator", canWrite: true });
    const returned = await app.inject({ method: "GET", url: "/api/admin/dashboard", headers: { cookie: first.cookie } });
    expect(returned.json()).toMatchObject({ accessMode: "observer", canWrite: false });
    expect(store.sessions.filter((item) => item.accessMode === "operator")).toHaveLength(1);
  });

  it("позволяет администратору опубликовать отзыв и добавить ответ", async () => {
    await seedCompletedPurchase();
    const created = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() });
    const { cookie, csrf } = await login();
    const update = await app.inject({
      method: "PATCH",
      url: `/api/admin/reviews/${created.json().id}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { status: "approved", adminReply: "Спасибо за ваш отзыв!" },
    });
    expect(update.statusCode).toBe(200);
    const reviews = await app.inject({ method: "GET", url: "/api/reviews" });
    expect(reviews.json().items[0].adminReply).toBe("Спасибо за ваш отзыв!");
  });

  it("защищает административные маршруты и CSRF", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/dashboard" })).statusCode).toBe(401);
    const { cookie } = await login();
    await seedCompletedPurchase();
    const review = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() });
    const noCsrf = await app.inject({ method: "PATCH", url: `/api/admin/reviews/${review.json().id}`, headers: { cookie }, payload: { status: "approved" } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("создаёт расчёт сопровождения и делит гривны между тремя игроками", async () => {
    const { cookie, csrf } = await login();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        item: "Сопровождение Metro Royale",
        buyerName: "Покупатель",
        buyerContact: "@buyer_test",
        buyerGameId: "1234567890",
        amount: "1000.00",
        currency: "UAH",
        orderDate: "2026-07-19",
        escorts: [
          { name: "Игрок один", gameId: "7000000001", contact: "@player_one" },
          { name: "Игрок два", gameId: "7000000002", contact: "@player_two" },
          { name: "Игрок три", gameId: "7000000003", contact: "@player_three" },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      buyerGameId: "1234567890",
      amountUah: "1000.00",
      directorAmountUah: "30.00",
      creatorAmountUah: "100.00",
      escortPoolUah: "870.00",
    });
    expect(response.json().participants.map((item: any) => item.shareUah)).toEqual(["290.00", "290.00", "290.00"]);

    const assignment = await app.inject({
      method: "PATCH",
      url: `/api/admin/escort-orders/${response.json().id}/participants/${response.json().participants[0].id}/assignment`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { status: "accepted" },
    });
    expect(assignment.statusCode).toBe(200);
    expect(assignment.json().participants[0].assignmentStatus).toBe("accepted");
    expect(notifier.operations).toContain("escort_assignment_changed");

    const completed = await app.inject({
      method: "PATCH",
      url: `/api/admin/escort-orders/${response.json().id}/status`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { status: "completed" },
    });
    expect(completed.statusCode).toBe(200);
    const completedOrders = await app.inject({ method: "GET", url: "/api/admin/escort-orders?status=completed", headers: { cookie } });
    expect(completedOrders.json().items.map((item: any) => item.id)).toContain(response.json().id);
    const dashboard = await app.inject({ method: "GET", url: "/api/admin/dashboard", headers: { cookie } });
    expect(dashboard.json().counts.completedEscortOrders).toBe(1);
  });

  it("ведёт профили, финансовый отчёт, аудит и отдельные ролевые аккаунты", async () => {
    const { cookie, csrf } = await login();
    const created = await app.inject({
      method: "POST", url: "/api/admin/escort-orders", headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Проверка операций", buyerName: "Покупатель", buyerGameId: "2234567890", amount: "750", currency: "UAH", orderDate: "2026-07-19",
        escorts: [{ name: "Профильный игрок", gameId: "7000000090", contact: "@profile_player" }] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reviewCode).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);

    const profiles = await app.inject({ method: "GET", url: "/api/admin/player-profiles?query=7000000090", headers: { cookie } });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.json().items[0]).toMatchObject({ gameId: "7000000090", orderCount: 1 });

    const report = await app.inject({ method: "GET", url: "/api/admin/reports/financial?from=2026-07-01&to=2026-07-31", headers: { cookie } });
    expect(report.json()).toMatchObject({ orderCount: 1, grossUah: "750.00", directorUah: "22.50", creatorUah: "75.00" });
    const csv = await app.inject({ method: "GET", url: "/api/admin/reports/financial.csv?from=2026-07-01&to=2026-07-31", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");

    const account = await app.inject({
      method: "POST", url: "/api/admin/accounts", headers: { cookie, "x-csrf-token": csrf },
      payload: { username: "watcher", password: "very-secure-observer", role: "observer" },
    });
    expect(account.statusCode).toBe(201);
    const observerLogin = await app.inject({ method: "POST", url: "/api/admin/login", payload: { username: "watcher", password: "very-secure-observer" } });
    const observerCookie = String(observerLogin.headers["set-cookie"]).split(";")[0];
    expect(observerLogin.json()).toMatchObject({ canWrite: false, admin: { role: "observer" } });
    const denied = await app.inject({ method: "PATCH", url: `/api/admin/escort-orders/${created.json().id}/status`,
      headers: { cookie: observerCookie, "x-csrf-token": observerLogin.json().csrfToken }, payload: { status: "completed" } });
    expect(denied.statusCode).toBe(403);

    const audit = await app.inject({ method: "GET", url: "/api/admin/audit-logs?page=1&pageSize=50", headers: { cookie } });
    expect(audit.json().items.map((item: any) => item.action)).toEqual(expect.arrayContaining(["escort_order.created", "admin.created"]));
  });

  it("исключает отменённое сопровождение из банков директора и создателя", async () => {
    const { cookie, csrf } = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        item: "Сопровождение",
        buyerName: "Покупатель",
        buyerGameId: "1234567890",
        amount: "1000",
        currency: "UAH",
        orderDate: "2026-07-19",
        escorts: [{ name: "Игрок", gameId: "7000000010" }],
      },
    });
    expect(created.statusCode).toBe(201);

    const activeBank = await app.inject({ method: "GET", url: "/api/admin/shop-bank", headers: { cookie } });
    expect(activeBank.json()).toMatchObject({ directorBalanceUah: "30.00", creatorBalanceUah: "100.00" });

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/admin/escort-orders/${created.json().id}/status`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { status: "cancelled" },
    });
    expect(cancelled.statusCode).toBe(200);

    const cancelledBank = await app.inject({ method: "GET", url: "/api/admin/shop-bank", headers: { cookie } });
    expect(cancelledBank.json()).toMatchObject({ directorBalanceUah: "0.00", creatorBalanceUah: "0.00" });
    const visibleOrders = await app.inject({ method: "GET", url: "/api/admin/escort-orders?page=1&pageSize=50", headers: { cookie } });
    expect(visibleOrders.json().items.map((order: any) => order.id)).not.toContain(created.json().id);
    const cancelledOrders = await app.inject({ method: "GET", url: "/api/admin/escort-orders?status=cancelled&page=1&pageSize=50", headers: { cookie } });
    expect(cancelledOrders.json().items.map((order: any) => order.id)).toContain(created.json().id);
  });

  it("защищает расчёты сопровождений и ограничивает число игроков", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/escort-orders" })).statusCode).toBe(401);
    const { cookie, csrf } = await login();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        item: "Сопровождение",
        buyerName: "Покупатель",
        buyerGameId: "1234567890",
        amount: "100",
        currency: "UAH",
        orderDate: "2026-07-19",
        escorts: [1, 2, 3, 4].map((number) => ({ name: `Игрок ${number}`, gameId: `70000001${number}` })),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("возвращает курс гривны без внешнего запроса", async () => {
    const { cookie } = await login();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/exchange-rate?currency=UAH&date=2026-07-19",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ currency: "UAH", date: "2026-07-19", rate: "1" });
  });

  it("позволяет отметить выплату сопровождающему", async () => {
    const { cookie, csrf } = await login();
    await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Сопровождение", buyerName: "Покупатель", buyerGameId: "1234567890", amount: "500", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Игрок", gameId: "7000000020" }] },
    });
    const order = store.escortOrders[0]!;
    const participant = order.participants[0]!;
    const paid = await app.inject({
      method: "PATCH",
      url: `/api/admin/escort-orders/${order.id}/participants/${participant.id}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { paid: true },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().participants[0].paid).toBe(true);
  });

  it("применяет ступени штрафов и зачисляет удержания в банк магазина", async () => {
    const { cookie, csrf } = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Сопровождение", buyerName: "Покупатель", buyerGameId: "1234567890", amount: "1000", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Игрок", gameId: "7000000030" }] },
    });
    const participantId = created.json().participants[0].id;
    let lastResponse;
    for (const reason of ["Опоздание", "Срыв захода", "Игнорирование команды", "Грубое нарушение"]) {
      lastResponse = await app.inject({
        method: "POST",
        url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/penalties`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { reason },
      });
      expect(lastResponse.statusCode).toBe(200);
    }
    const player = lastResponse!.json().participants[0];
    expect(player.penalties.map((penalty: any) => penalty.percentage)).toEqual([5, 10, 15, 50]);
    expect(player.penaltyTotalUah).toBe("696.00");
    expect(player.payoutUah).toBe("174.00");
    expect(player).toMatchObject({ active: false, nextPenaltyPercent: null });
    expect(player.excludedAt).toBeTruthy();
    expect(player.suspendedUntil).toBeTruthy();
    const suspendedOrder = await app.inject({
      method: "POST", url: "/api/admin/escort-orders", headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Повторное сопровождение", buyerName: "Другой покупатель", buyerGameId: "3234567890", amount: "500", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Игрок", gameId: "7000000030" }] },
    });
    expect(suspendedOrder.statusCode).toBe(400);
    const bank = await app.inject({ method: "GET", url: "/api/admin/shop-bank", headers: { cookie } });
    expect(bank.json()).toMatchObject({ penaltyBalanceUah: "696.00", directorBalanceUah: "30.00", creatorBalanceUah: "100.00" });
    const fifth = await app.inject({
      method: "POST",
      url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/penalties`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { reason: "Повторное нарушение" },
    });
    expect(fifth.statusCode).toBe(200);
    expect(fifth.json().participants[0]).toMatchObject({ permanentlyBanned: true, dailyViolationCount: 5 });
    const sixth = await app.inject({
      method: "POST",
      url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/penalties`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { reason: "Шестое нарушение" },
    });
    expect(sixth.statusCode).toBe(409);
  });

  it("показывает штрафы в отдельном меню и удаляет их с пересчётом ограничений", async () => {
    const { cookie, csrf } = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Проверка удаления штрафа", buyerName: "Покупатель", buyerGameId: "4234567890", amount: "1000", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Штрафуемый игрок", gameId: "7000000031" }] },
    });
    const participantId = created.json().participants[0].id;
    for (const reason of ["Первое нарушение", "Второе нарушение", "Третье нарушение", "Четвёртое нарушение"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/penalties`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { reason },
      });
      expect(response.statusCode).toBe(200);
    }

    const penalties = await app.inject({ method: "GET", url: "/api/admin/penalties?query=7000000031&page=1&pageSize=50", headers: { cookie } });
    expect(penalties.statusCode).toBe(200);
    expect(penalties.json().total).toBe(4);
    const fourth = penalties.json().items.find((penalty: any) => penalty.percentage === 50);
    const paid = await app.inject({
      method: "PATCH",
      url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { paid: true },
    });
    expect(paid.statusCode).toBe(200);
    const protectedRemoval = await app.inject({
      method: "DELETE",
      url: `/api/admin/penalties/${fourth.id}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { clearPaid: false },
    });
    expect(protectedRemoval.statusCode).toBe(409);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/penalties/${fourth.id}`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { clearPaid: true },
    });
    expect(removed.statusCode).toBe(200);

    const orders = await app.inject({ method: "GET", url: "/api/admin/escort-orders?status=planned&page=1&pageSize=50", headers: { cookie } });
    const player = orders.json().items.find((order: any) => order.id === created.json().id).participants[0];
    expect(player.penalties.map((penalty: any) => penalty.percentage)).toEqual([5, 10, 15]);
    expect(player).toMatchObject({ active: true, permanentlyBanned: false, dailyViolationCount: 3, paid: false });
    expect(player.suspendedUntil).toBeNull();
    expect(player.penaltyTotalUah).toBe("261.00");
    const remaining = await app.inject({ method: "GET", url: "/api/admin/penalties?query=7000000031&page=1&pageSize=50", headers: { cookie } });
    expect(remaining.json().total).toBe(3);
    const audit = await app.inject({ method: "GET", url: "/api/admin/audit-logs?page=1&pageSize=50", headers: { cookie } });
    expect(audit.json().items.map((item: any) => item.action)).toContain("escort_penalty.deleted");
  });

  it("сохраняет историю замены и передаёт новому игроку остаток доли", async () => {
    const { cookie, csrf } = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Сопровождение", buyerName: "Покупатель", buyerGameId: "1234567890", amount: "1000", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Первый игрок", gameId: "7000000040" }] },
    });
    const participantId = created.json().participants[0].id;
    await app.inject({
      method: "POST",
      url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/penalties`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { reason: "Опоздание" },
    });
    const replaced = await app.inject({
      method: "POST",
      url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/replacement`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { name: "Новый игрок", gameId: "7000000041", contact: "@new_player" },
    });
    expect(replaced.statusCode).toBe(200);
    const [oldPlayer, newPlayer] = replaced.json().participants;
    expect(oldPlayer).toMatchObject({ active: false, payoutUah: "0.00" });
    expect(newPlayer).toMatchObject({ active: true, shareUah: "826.50", payoutUah: "826.50", nextPenaltyPercent: 5 });
    expect(newPlayer.replacementForId).toBe(oldPlayer.id);
    expect(replaced.json().bankFromPenaltiesUah).toBe("43.50");
  });

  it("создаёт заявку и разрешает доступ только с секретным токеном", async () => {
    const created = await app.inject({ method: "POST", url: "/api/support/tickets", payload: ticketPayload() });
    expect(created.statusCode).toBe(201);
    expect(notifier.tickets).toHaveLength(1);
    const body = created.json();
    const denied = await app.inject({ method: "GET", url: `/api/support/tickets/${body.number}`, headers: { "x-ticket-token": "wrong" } });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({ method: "GET", url: `/api/support/tickets/${body.number}`, headers: { "x-ticket-token": body.token } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().messages).toHaveLength(1);
    expect(allowed.json().secretTokenHash).toBeUndefined();
  });

  it("сохраняет переписку пользователя и администратора", async () => {
    const created = await app.inject({ method: "POST", url: "/api/support/tickets", payload: ticketPayload() });
    const ticketAccess = created.json();
    const userMessage = await app.inject({
      method: "POST",
      url: `/api/support/tickets/${ticketAccess.number}/messages`,
      headers: { "x-ticket-token": ticketAccess.token },
      payload: { message: "Добавляю информацию к обращению" },
    });
    expect(userMessage.statusCode).toBe(201);
    expect(notifier.messages).toHaveLength(1);

    const { cookie, csrf } = await login();
    const ticket = store.tickets[0]!;
    const adminMessage = await app.inject({
      method: "POST",
      url: `/api/admin/tickets/${ticket.id}/messages`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { message: "Спасибо, менеджер уже проверяет информацию" },
    });
    expect(adminMessage.statusCode).toBe(201);
    expect(ticket.messages).toHaveLength(3);
    expect(ticket.status).toBe("waiting_user");
  });

  it("позволяет администратору менять статус заявки", async () => {
    await app.inject({ method: "POST", url: "/api/support/tickets", payload: ticketPayload() });
    const { cookie, csrf } = await login();
    const ticket = store.tickets[0]!;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/tickets/${ticket.id}/status`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { status: "closed" },
    });
    expect(response.statusCode).toBe(200);
    expect(ticket.status).toBe("closed");
  });

  it("не возвращает внутренние секреты заявки через админ API", async () => {
    await app.inject({ method: "POST", url: "/api/support/tickets", payload: ticketPayload() });
    const { cookie } = await login();
    const response = await app.inject({ method: "GET", url: `/api/admin/tickets/${store.tickets[0]!.id}`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().secretTokenHash).toBeUndefined();
    expect(response.json().ipHash).toBeUndefined();
  });
});
