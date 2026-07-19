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

  const reviewPayload = (text = "Отличный магазин и быстрая помощь") => ({
    name: "Сергей",
    contact: "@serhii_test",
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
    return { cookie, csrf: body.csrfToken };
  }

  it("показывает дружелюбный статус на корневом адресе API", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "Undying Metro Shop API" });
  });

  it("показывает двух свободных менеджеров и фиксирует занятость на 10 минут", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/managers" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().items).toEqual([
      { key: "manager_1", status: "available", busyUntil: null },
      { key: "manager_2", status: "available", busyUntil: null },
    ]);

    const claimed = await app.inject({ method: "POST", url: "/api/managers/manager_1/claim" });
    expect(claimed.statusCode).toBe(201);
    const remaining = new Date(claimed.json().busyUntil).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(9 * 60 * 1000);

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
    const response = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() });
    expect(response.statusCode).toBe(201);
    expect(response.json().status).toBe("pending");
    expect(store.reviews).toHaveLength(1);
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

  it("не принимает повтор одного отзыва", async () => {
    expect((await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() })).statusCode).toBe(409);
  });

  it("ограничивает частую отправку отзывов", async () => {
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload(`Уникальный хороший отзыв номер ${index}`) });
      expect(response.statusCode).toBe(201);
    }
    const limited = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload("Четвёртый уникальный хороший отзыв") });
    expect(limited.statusCode).toBe(429);
  });

  it("позволяет администратору опубликовать отзыв и добавить ответ", async () => {
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
    const review = await app.inject({ method: "POST", url: "/api/reviews", payload: reviewPayload() });
    const noCsrf = await app.inject({ method: "PATCH", url: `/api/admin/reviews/${review.json().id}`, headers: { cookie }, payload: { status: "approved" } });
    expect(noCsrf.statusCode).toBe(403);
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
