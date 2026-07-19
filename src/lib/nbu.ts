import { z } from "zod";
import type { OrderCurrency } from "../types/domain.js";

const nbuResponse = z.array(z.object({
  cc: z.string(),
  rate: z.number().positive(),
  exchangedate: z.string().optional(),
}));

export async function getOfficialNbuRate(currency: OrderCurrency, date: string): Promise<number> {
  if (currency === "UAH") return 1;
  const compactDate = date.replaceAll("-", "");
  const url = new URL("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange");
  url.searchParams.set("valcode", currency);
  url.searchParams.set("date", compactDate);
  url.searchParams.set("json", "");

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "UndyingMetroShop/1.0 (+https://github.com/SerhiiKharyponcuk/undying-metro-shop)",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`NBU ${response.status}`);
    const parsed = nbuResponse.safeParse(await response.json());
    const item = parsed.success ? parsed.data.find((value) => value.cc.toUpperCase() === currency) : undefined;
    if (!item) throw new Error("Currency rate missing");
    return item.rate;
  } catch {
    throw new Error("Не удалось получить курс НБУ. Укажите курс вручную.");
  }
}
