import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AdminNotifier } from "../src/lib/telegram.js";
import { hashSecret } from "../src/lib/security.js";
import type { ReviewRecord, SupportMessageRecord, SupportTicketRecord } from "../src/types/domain.js";
import { MemoryStore } from "./memory-store.js";

class RecordingNotifier implements AdminNotifier {
  reviews: string[] = [];
  tickets: string[] = [];
  messages: string[] = [];
  async review(review: ReviewRecord) { this.reviews.push(review.id); }
  async ticket(ticket: SupportTicketRecord) { this.tickets.push(ticket.id); }
  async ticketMessage(ticket: SupportTicketRecord, message: SupportMessageRecord) { this.messages.push(`${ticket.id}:${message.id}`); }
}

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 10000,
  databaseUrl: "postgresql://test:test@localhost:5432/test",
  corsOrigins: ["https://example.test"],
  cookieSecret: "c".repeat(40),
  ticketTokenPepper: "t".repeat(40),
  ipHashSalt: "i".repeat(40),
  sessionTtlHours: 24,
  turnstileRequired: false,
  turnstileSecretKey: "",
  telegramBotToken: "",
  telegramAdminChatIds: [],
  adminPanelUrl: "https://example.test/admin/",
};

describe("Undying Metro API", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let notifier: RecordingNotifier;

  beforeEach(async () => {
    store = new MemoryStore();
    notifier = new RecordingNotifier();
    await store.createAdmin("admin", await hashSecret("very-secure-password"));
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
    return { cookie, csrf: body.csrfToken, accessMode: body.accessMode as "operator" | "observer" };
  }

  async function seedCompletedPurchase(buyerGameId = "1234567890") {
    const order = await store.createEscortOrder({
      item: "Проверенная покупка",
      buyerName: "Покупатель",
      buyerContact: null,
      buyerGameId,
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
      participants: [{ name: "Сопровождающий", contact: null, shareUahMinor: 0n }],
    });
    await store.updateEscortOrderStatus(order.id, "completed");
    return order;
  }

  it("показывает дружелюбный статус на корневом адресе API", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "Undying Metro Shop API" });
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
  });

  it("разрешает отзыв только по PUBG ID завершённого или оплаченного заказа", async () => {
    const invalidId = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Хороший сервис и быстрая помощь", "abc") });
    expect(invalidId.statusCode).toBe(400);

    const unknownId = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Хороший сервис и быстрая помощь", "9999999999") });
    expect(unknownId.statusCode).toBe(403);
    expect(unknownId.json().error).toContain("PUBG ID");

    await seedCompletedPurchase("9999999999");
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
          { name: "Игрок один", contact: "@player_one" },
          { name: "Игрок два", contact: "@player_two" },
          { name: "Игрок три", contact: "@player_three" },
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
        escorts: [{ name: "Игрок" }],
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
        escorts: [1, 2, 3, 4].map((number) => ({ name: `Игрок ${number}` })),
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
      payload: { item: "Сопровождение", buyerName: "Покупатель", buyerGameId: "1234567890", amount: "500", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Игрок" }] },
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
      payload: { item: "Сопровождение", buyerName: "Покупатель", buyerGameId: "1234567890", amount: "1000", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Игрок" }] },
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
    const bank = await app.inject({ method: "GET", url: "/api/admin/shop-bank", headers: { cookie } });
    expect(bank.json()).toMatchObject({ penaltyBalanceUah: "696.00", directorBalanceUah: "30.00", creatorBalanceUah: "100.00" });
    const fifth = await app.inject({
      method: "POST",
      url: `/api/admin/escort-orders/${created.json().id}/participants/${participantId}/penalties`,
      headers: { cookie, "x-csrf-token": csrf },
      payload: { reason: "Повторное нарушение" },
    });
    expect(fifth.statusCode).toBe(409);
  });

  it("сохраняет историю замены и передаёт новому игроку остаток доли", async () => {
    const { cookie, csrf } = await login();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/escort-orders",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { item: "Сопровождение", buyerName: "Покупатель", buyerGameId: "1234567890", amount: "1000", currency: "UAH", orderDate: "2026-07-19", escorts: [{ name: "Первый игрок" }] },
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
      payload: { name: "Новый игрок", contact: "@new_player" },
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
