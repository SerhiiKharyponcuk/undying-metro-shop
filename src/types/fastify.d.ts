import type { AdminRecord, AdminSessionRecord } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    adminAuth?: {
      admin: AdminRecord;
      session: AdminSessionRecord;
    };
  }
}

export {};
