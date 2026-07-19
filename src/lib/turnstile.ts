import type { AppConfig } from "../config.js";

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
}

export async function verifyTurnstile(config: AppConfig, token: string, remoteIp: string): Promise<boolean> {
  if (!config.turnstileRequired) return true;
  if (!config.turnstileSecretKey || !token) return false;

  const body = new URLSearchParams({
    secret: config.turnstileSecretKey,
    response: token,
    remoteip: remoteIp,
  });

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return false;
    const result = (await response.json()) as TurnstileResponse;
    return result.success === true;
  } catch {
    return false;
  }
}
