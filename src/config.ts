import { z } from "zod";
import { createHash } from "node:crypto";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(10000),
    DATABASE_URL: z.string().min(1),
    CORS_ORIGINS: z.string().default("http://localhost:5500"),
    COOKIE_SECRET: z.string().min(32),
    TICKET_TOKEN_PEPPER: z.string().min(32),
    REVIEW_CODE_PEPPER: z.string().min(32),
    IP_HASH_SALT: z.string().min(32),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    TURNSTILE_REQUIRED: z
      .string()
      .default("false")
      .transform((value) => value === "true"),
    TURNSTILE_SECRET_KEY: z.string().optional().default(""),
    TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
    TELEGRAM_ADMIN_CHAT_IDS: z.string().optional().default(""),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(24).optional().or(z.literal("")).default(""),
    ADMIN_PANEL_URL: z.string().url().optional().or(z.literal("")).default(""),
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === "production" && !environment.TURNSTILE_REQUIRED) {
      context.addIssue({
        code: "custom",
        path: ["TURNSTILE_REQUIRED"],
        message: "в production должно быть установлено значение true",
      });
    }
    if (environment.NODE_ENV === "production" && environment.TURNSTILE_REQUIRED && !environment.TURNSTILE_SECRET_KEY) {
      context.addIssue({
        code: "custom",
        path: ["TURNSTILE_SECRET_KEY"],
        message: "TURNSTILE_SECRET_KEY обязателен в production",
      });
    }
  });

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  cookieSecret: string;
  ticketTokenPepper: string;
  reviewCodePepper: string;
  ipHashSalt: string;
  sessionTtlHours: number;
  turnstileRequired: boolean;
  turnstileSecretKey: string;
  telegramBotToken: string;
  telegramAdminChatIds: string[];
  adminPanelUrl: string;
  telegramWebhookSecret: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Ошибка переменных окружения: ${summary}`);
  }

  const value = parsed.data;

  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    corsOrigins: value.CORS_ORIGINS.split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
    cookieSecret: value.COOKIE_SECRET,
    ticketTokenPepper: value.TICKET_TOKEN_PEPPER,
    reviewCodePepper: value.REVIEW_CODE_PEPPER,
    ipHashSalt: value.IP_HASH_SALT,
    sessionTtlHours: value.SESSION_TTL_HOURS,
    turnstileRequired: value.TURNSTILE_REQUIRED,
    turnstileSecretKey: value.TURNSTILE_SECRET_KEY,
    telegramBotToken: value.TELEGRAM_BOT_TOKEN,
    telegramAdminChatIds: value.TELEGRAM_ADMIN_CHAT_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    adminPanelUrl: value.ADMIN_PANEL_URL,
    telegramWebhookSecret: value.TELEGRAM_WEBHOOK_SECRET || createHash("sha256").update(`telegram:${value.COOKIE_SECRET}`).digest("hex"),
  };
}
