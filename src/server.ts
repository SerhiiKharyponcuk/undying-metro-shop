import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { bootstrapInitialAdmin } from "./lib/bootstrap-admin.js";
import { TelegramNotifier } from "./lib/telegram.js";
import { PrismaStore } from "./store/prisma-store.js";

const config = loadConfig();
const prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
const store = new PrismaStore(prisma);
const app = await buildApp({
  config,
  store,
  notifier: (logger) => new TelegramNotifier(config, store, logger),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

async function configureTelegramWebhook(): Promise<void> {
  if (!config.telegramBotToken || !config.telegramWebhookSecret || !config.adminPanelUrl) return;
  const webhookUrl = `${new URL(config.adminPanelUrl).origin}/api/telegram/webhook`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: config.telegramWebhookSecret, allowed_updates: ["message"], drop_pending_updates: false }),
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    app.log.info({ webhookUrl }, "Telegram webhook configured");
  } catch (error) {
    app.log.error({ err: error }, "Unable to configure Telegram webhook");
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await prisma.$connect();
  await bootstrapInitialAdmin(prisma, process.env, app.log);
  await app.listen({ host: config.host, port: config.port });
  await configureTelegramWebhook();
} catch (error) {
  app.log.fatal({ err: error }, "Unable to start server");
  await prisma.$disconnect();
  process.exit(1);
}
