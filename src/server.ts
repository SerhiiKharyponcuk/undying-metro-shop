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

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await prisma.$connect();
  await bootstrapInitialAdmin(prisma, process.env, app.log);
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "Unable to start server");
  await prisma.$disconnect();
  process.exit(1);
}
