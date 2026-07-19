import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hashSecret } from "./security.js";

const bootstrapSchema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(256),
});

export async function bootstrapInitialAdmin(
  prisma: PrismaClient,
  environment: NodeJS.ProcessEnv,
  logger: Pick<FastifyBaseLogger, "info">,
): Promise<"skipped" | "exists" | "created"> {
  const username = environment.ADMIN_INITIAL_USERNAME?.trim() ?? "";
  const password = environment.ADMIN_INITIAL_PASSWORD ?? "";

  if (!username && !password) return "skipped";

  const input = bootstrapSchema.safeParse({ username, password });
  if (!input.success) {
    const fields = [...new Set(input.error.issues.map((issue) => issue.path.join(".") || "данные"))].join(", ");
    throw new Error(`Не удалось создать первого администратора: проверьте ${fields}`);
  }

  const existingCount = await prisma.admin.count();
  if (existingCount > 0) {
    logger.info("Initial administrator already exists; automatic creation skipped");
    return "exists";
  }

  const passwordHash = await hashSecret(input.data.password);
  await prisma.admin.create({
    data: {
      username: input.data.username,
      passwordHash,
    },
  });
  logger.info({ username: input.data.username }, "Initial administrator created automatically");
  return "created";
}
