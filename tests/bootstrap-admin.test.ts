import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin } from "../src/lib/bootstrap-admin.js";
import { verifySecret } from "../src/lib/security.js";

function dependencies(existingAdmins = 0) {
  const admin = {
    count: vi.fn().mockResolvedValue(existingAdmins),
    create: vi.fn().mockResolvedValue({ id: "admin-id" }),
  };
  const logger = { info: vi.fn() };
  return {
    admin,
    logger,
    prisma: { admin } as unknown as PrismaClient,
  };
}

describe("automatic initial administrator", () => {
  it("ничего не делает без переменных окружения", async () => {
    const { prisma, admin, logger } = dependencies();
    await expect(bootstrapInitialAdmin(prisma, {}, logger as any)).resolves.toBe("skipped");
    expect(admin.count).not.toHaveBeenCalled();
    expect(admin.create).not.toHaveBeenCalled();
  });

  it("не запускается с неполной конфигурацией", async () => {
    const { prisma, admin, logger } = dependencies();
    await expect(
      bootstrapInitialAdmin(prisma, { ADMIN_INITIAL_USERNAME: "ADMIN_SHOP" }, logger as any),
    ).rejects.toThrow("password");
    expect(admin.count).not.toHaveBeenCalled();
  });

  it("создаёт только первого администратора и хеширует пароль", async () => {
    const { prisma, admin, logger } = dependencies();
    const password = "A-secure-test-password-2026";
    await expect(
      bootstrapInitialAdmin(
        prisma,
        { ADMIN_INITIAL_USERNAME: "ADMIN_SHOP", ADMIN_INITIAL_PASSWORD: password },
        logger as any,
      ),
    ).resolves.toBe("created");

    const input = admin.create.mock.calls[0]![0].data;
    expect(input.username).toBe("admin_shop");
    expect(input.passwordHash).not.toBe(password);
    await expect(verifySecret(input.passwordHash, password)).resolves.toBe(true);
  });

  it("не создаёт нового пользователя, если администратор уже существует", async () => {
    const { prisma, admin, logger } = dependencies(1);
    await expect(
      bootstrapInitialAdmin(
        prisma,
        { ADMIN_INITIAL_USERNAME: "another_admin", ADMIN_INITIAL_PASSWORD: "Another-secure-password-2026" },
        logger as any,
      ),
    ).resolves.toBe("exists");
    expect(admin.create).not.toHaveBeenCalled();
  });
});
