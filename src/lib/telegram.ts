import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { AppStore } from "../store/store.js";
import type { ReviewRecord, SupportMessageRecord, SupportTicketRecord } from "../types/domain.js";
import { redactError } from "./security.js";

export interface AdminNotifier {
  review(review: ReviewRecord): Promise<void>;
  ticket(ticket: SupportTicketRecord): Promise<void>;
  ticketMessage(ticket: SupportTicketRecord, message: SupportMessageRecord): Promise<void>;
}

export class NoopNotifier implements AdminNotifier {
  async review(): Promise<void> {}
  async ticket(): Promise<void> {}
  async ticketMessage(): Promise<void> {}
}

export class TelegramNotifier implements AdminNotifier {
  constructor(
    private readonly config: AppConfig,
    private readonly store: AppStore,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async review(review: ReviewRecord): Promise<void> {
    const link = this.config.adminPanelUrl ? `${this.config.adminPanelUrl}?section=reviews&id=${review.id}` : "";
    await this.send(
      "review_created",
      [
        "⭐ Новый отзыв",
        `Имя: ${review.name}`,
        `Оценка: ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}`,
        `Текст: ${review.text}`,
        `Дата: ${review.createdAt.toISOString()}`,
        link ? `Модерация: ${link}` : "",
      ].filter(Boolean).join("\n"),
    );
  }

  async ticket(ticket: SupportTicketRecord): Promise<void> {
    const categoryLabels: Record<string, string> = {
      purchase: "Покупка",
      payment: "Оплата",
      product_problem: "Проблема с товаром",
      partnership: "Сотрудничество",
      complaint: "Жалоба",
      other: "Другое",
    };
    const firstMessage = ticket.messages[0]?.message ?? "";
    const link = this.config.adminPanelUrl ? `${this.config.adminPanelUrl}?section=tickets&id=${ticket.id}` : "";
    await this.send(
      "ticket_created",
      [
        "🛡 Новое обращение в поддержку",
        `Номер: ${ticket.publicNumber}`,
        `Категория: ${categoryLabels[ticket.category] ?? ticket.category}`,
        `Имя: ${ticket.name}`,
        `Контакт: ${ticket.contact}`,
        `Тема: ${ticket.subject}`,
        `Сообщение: ${firstMessage}`,
        `Дата: ${ticket.createdAt.toISOString()}`,
        link ? `Открыть: ${link}` : "",
      ].filter(Boolean).join("\n"),
    );
  }

  async ticketMessage(ticket: SupportTicketRecord, message: SupportMessageRecord): Promise<void> {
    const link = this.config.adminPanelUrl ? `${this.config.adminPanelUrl}?section=tickets&id=${ticket.id}` : "";
    await this.send(
      "ticket_user_message",
      [
        "💬 Новое сообщение пользователя",
        `Заявка: ${ticket.publicNumber}`,
        `Сообщение: ${message.message}`,
        link ? `Ответить: ${link}` : "",
      ].filter(Boolean).join("\n"),
    );
  }

  private async send(eventType: string, message: string): Promise<void> {
    const { telegramBotToken: token, telegramAdminChatIds: destinations } = this.config;

    if (!token || destinations.length === 0) {
      await this.safeLog({ eventType, destination: "telegram", status: "skipped" });
      return;
    }

    const safeMessage = message.slice(0, 3900);

    await Promise.all(
      destinations.map(async (chatId) => {
        try {
          const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: safeMessage, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(7_000),
          });

          if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
          await this.safeLog({ eventType, destination: chatId, status: "sent" });
        } catch (error) {
          const safeError = redactError(error);
          this.logger.error({ eventType, destination: chatId, error: safeError }, "Telegram notification failed");
          await this.safeLog({ eventType, destination: chatId, status: "failed", error: safeError });
        }
      }),
    );
  }

  private async safeLog(input: {
    eventType: string;
    destination: string;
    status: "sent" | "failed" | "skipped";
    error?: string;
  }): Promise<void> {
    try {
      await this.store.createNotificationLog(input);
    } catch (error) {
      this.logger.error({ eventType: input.eventType, error: redactError(error) }, "Notification log write failed");
    }
  }
}
