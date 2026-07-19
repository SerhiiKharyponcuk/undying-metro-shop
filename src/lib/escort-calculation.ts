const MONEY_PATTERN = /^\d{1,9}(?:[.,]\d{1,2})?$/;
const RATE_PATTERN = /^\d{1,5}(?:[.,]\d{1,6})?$/;
const RATE_SCALE = 1_000_000n;
export const PENALTY_PERCENTAGES = [5, 10, 15, 50] as const;

function decimalToScaled(value: string | number, decimals: number, pattern: RegExp, label: string): bigint {
  const normalized = String(value).trim().replace(",", ".");
  if (!pattern.test(normalized)) throw new Error(`Некорректное значение: ${label}`);
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

export function parseMoneyToMinor(value: string | number): bigint {
  const amount = decimalToScaled(value, 2, MONEY_PATTERN, "сумма");
  if (amount <= 0n) throw new Error("Сумма должна быть больше нуля");
  return amount;
}

export function parseRateToMicros(value: string | number): bigint {
  const rate = decimalToScaled(value, 6, RATE_PATTERN, "курс");
  if (rate <= 0n) throw new Error("Курс должен быть больше нуля");
  return rate;
}

function roundedDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

export function calculateEscortSplit(originalAmountMinor: bigint, exchangeRateMicros: bigint, escortCount: number) {
  if (!Number.isInteger(escortCount) || escortCount < 1 || escortCount > 3) {
    throw new Error("Укажите от одного до трёх сопровождающих");
  }
  const amountUahMinor = roundedDivide(originalAmountMinor * exchangeRateMicros, RATE_SCALE);
  const creatorAmountMinor = roundedDivide(amountUahMinor * 3n, 100n);
  const escortPoolMinor = amountUahMinor - creatorAmountMinor;
  const count = BigInt(escortCount);
  const baseShare = escortPoolMinor / count;
  const remainder = escortPoolMinor % count;
  const shares = Array.from({ length: escortCount }, (_, index) => baseShare + (BigInt(index) < remainder ? 1n : 0n));
  return { amountUahMinor, creatorAmountMinor, escortPoolMinor, shares };
}

export function calculatePenaltyAmount(shareUahMinor: bigint, sequence: number): { percentage: number; amountUahMinor: bigint } {
  const percentage = PENALTY_PERCENTAGES[sequence - 1];
  if (!percentage) throw new Error("Для игрока уже применены все ступени штрафов");
  const amountUahMinor = roundedDivide(shareUahMinor * BigInt(percentage), 100n);
  return { percentage, amountUahMinor };
}

export function formatMinor(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  const sign = value < 0n ? "-" : "";
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function formatRate(value: bigint): string {
  const whole = value / RATE_SCALE;
  const fraction = String(value % RATE_SCALE).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
