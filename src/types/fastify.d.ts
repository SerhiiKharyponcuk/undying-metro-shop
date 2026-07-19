import type { AdminAccessMode, AdminRecord, AdminSessionRecord } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    adminAuth?: {
      admin: AdminRecord;
      session: AdminSessionRecord;
      accessMode: AdminAccessMode;
    };
  }
}

export {};
