import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { hashSecret } from "../lib/security.js";

const input = z.object({
  DATABASE_URL: z.string().min(1),
  ADMIN_INITIAL_USERNAME: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  ADMIN_INITIAL_PASSWORD: z.string().min(12).max(256),
  ADMIN_INITIAL_ROLE: z.enum(["owner", "director", "admin", "observer"]).optional().default("admin"),
}).parse(process.env);

const prisma = new PrismaClient({ datasourceUrl: input.DATABASE_URL });

try {
  const username = input.ADMIN_INITIAL_USERNAME.toLowerCase();
  const existing = await prisma.admin.findUnique({ where: { username } });
  if (existing) throw new Error("Администратор с таким логином уже существует");
  const passwordHash = await hashSecret(input.ADMIN_INITIAL_PASSWORD);
  const count = await prisma.admin.count();
  const admin = await prisma.admin.create({ data: { username, passwordHash, role: count === 0 ? "owner" : input.ADMIN_INITIAL_ROLE } });
  console.log(`Администратор ${admin.username} создан. Удалите ADMIN_INITIAL_PASSWORD из переменных окружения.`);
} finally {
  await prisma.$disconnect();
}
