import { describe, expect, it } from "vitest";
import { calculateEscortSplit, calculatePenaltyAmount, formatMinor, parseMoneyToMinor, parseRateToMicros } from "../src/lib/escort-calculation.js";

describe("escort financial calculation", () => {
  it("конвертирует оплату, отдаёт 10% разработчику и делит остаток на троих", () => {
    const result = calculateEscortSplit(parseMoneyToMinor("100"), parseRateToMicros("50"), 3);
    expect(formatMinor(result.amountUahMinor)).toBe("5000.00");
    expect(formatMinor(result.developerAmountMinor)).toBe("500.00");
    expect(result.shares.map(formatMinor)).toEqual(["1500.00", "1500.00", "1500.00"]);
  });

  it("распределяет остаток копеек без потери денег", () => {
    const result = calculateEscortSplit(parseMoneyToMinor("100.01"), parseRateToMicros("1"), 3);
    expect(result.developerAmountMinor + result.shares.reduce((sum, share) => sum + share, 0n)).toBe(result.amountUahMinor);
    expect(result.shares[0]! - result.shares[2]!).toBeLessThanOrEqual(1n);
  });

  it("не допускает больше трёх сопровождающих", () => {
    expect(() => calculateEscortSplit(10_000n, 1_000_000n, 4)).toThrow("трёх");
  });

  it("использует фиксированную шкалу штрафов 5, 10, 15 и 50 процентов", () => {
    const share = 90_000n;
    expect([1, 2, 3, 4].map((sequence) => calculatePenaltyAmount(share, sequence))).toEqual([
      { percentage: 5, amountUahMinor: 4_500n },
      { percentage: 10, amountUahMinor: 9_000n },
      { percentage: 15, amountUahMinor: 13_500n },
      { percentage: 50, amountUahMinor: 45_000n },
    ]);
    expect(() => calculatePenaltyAmount(share, 5)).toThrow("все ступени");
  });
});
