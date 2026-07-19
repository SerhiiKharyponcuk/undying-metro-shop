import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomCode(length = 4): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function keyedHash(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function hashIp(ip: string, salt: string): string {
  return keyedHash(ip, salt);
}

export function contentFingerprint(parts: string[], salt: string): string {
  return keyedHash(parts.map((part) => part.trim().toLowerCase()).join("\u001f"), salt);
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function containsMarkup(value: string): boolean {
  return /<\/?[a-z][\s\S]*?>|javascript:|data:text\/html/i.test(value);
}

export function cleanPlainText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Неизвестная ошибка";
  return message.replace(/(token|password|secret|authorization|cookie)\s*[=:]\s*\S+/gi, "$1=[REDACTED]").slice(0, 550);
}
