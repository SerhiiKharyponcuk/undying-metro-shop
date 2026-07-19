import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { AdminNotifier } from "./lib/telegram.js";
import { NoopNotifier } from "./lib/telegram.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerPublicRoutes } from "./routes/public.js";
import type { AppStore } from "./store/store.js";

export async function buildApp(input: {
  config: AppConfig;
  store: AppStore;
  notifier?: AdminNotifier | ((logger: FastifyBaseLogger) => AdminNotifier);
  logger?: boolean;
}): Promise<FastifyInstance> {
  const { config, store } = input;
  const app = Fastify({
    logger: input.logger ?? config.nodeEnv !== "test"
      ? {
          level: config.nodeEnv === "production" ? "info" : "debug",
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers['x-ticket-token']",
            "res.headers.set-cookie",
            "req.body.password",
            "req.body.token",
            "req.body.turnstileToken",
          ],
        }
      : false,
    trustProxy: true,
    bodyLimit: 32 * 1024,
  });
  const notifier = typeof input.notifier === "function" ? input.notifier(app.log) : input.notifier ?? new NoopNotifier();

  await app.register(cookie, { secret: config.cookieSecret, hook: "onRequest" });
  await app.register(cors, {
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token", "x-ticket-token"],
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, "");
      return callback(null, config.corsOrigins.includes(normalized));
    },
  });
  await app.register(helmet, {
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ statusCode: 429, error: "Слишком много запросов. Попробуйте позже." }),
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const normalized = error instanceof Error ? error : new Error("Unknown request error");
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    request.log.error({ err: normalized }, "Unhandled request error");
    if (reply.sent) return;
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    return reply.code(status).send({
      error: status === 500 ? "Внутренняя ошибка сервера" : normalized.message,
      requestId: request.id,
    });
  });

  await registerPublicRoutes(app, { store, config, notifier });
  await registerAdminRoutes(app, { store, config });

  return app;
}
