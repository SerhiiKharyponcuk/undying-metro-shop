(() => {
  "use strict";
  const base = String(window.UNDYING_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
  const money = (value) => `${Number(value || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₴`;
  const statusLabels = { planned: "Запланирован", completed: "Выполнен", paid: "Выплачен", cancelled: "Отменён" };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelector("#playerSection").hidden = button.dataset.tab !== "player";
    document.querySelector("#buyerSection").hidden = button.dataset.tab !== "buyer";
  }));

  let playerCredentials = null;
  async function loadPlayer(gameId, code) {
    const response = await fetch(`${base}/api/escort-portal/${encodeURIComponent(gameId)}`, { headers: { "x-player-code": code } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Не удалось открыть кабинет");
    playerCredentials = { gameId, code };
    const target = document.querySelector("#playerResult");
    target.innerHTML = `<div class="grid"><article class="card"><h2>${escape(data.profile.displayName)}</h2><p>PUBG ID ${escape(data.profile.gameId)}</p><p class="muted">${data.profile.permanentlyBanned ? "Постоянная блокировка" : data.profile.suspendedUntil ? `Отстранён до ${new Date(data.profile.suspendedUntil).toLocaleString("ru-RU")}` : "Допущен к сопровождениям"}</p></article></div><div class="grid">${data.orders.map((order) => `<article class="card"><h3>${escape(order.item)}</h3><p>${new Date(order.orderDate).toLocaleDateString("ru-RU")} • ${escape(statusLabels[order.status] || order.status)}</p><div class="numbers"><span>Доля: ${money(order.shareUah)}</span><span>Штрафы: ${money(order.withheldUah)}</span><span>К выплате: ${money(order.payoutUah)}</span><span>${order.paid ? "Выплачено" : "Ожидает выплаты"}</span></div>${order.penalties.map((penalty) => `<div class="penalty"><strong>−${penalty.percentage}% • ${money(penalty.amountUah)}</strong><p>${escape(penalty.reason)}</p>${penalty.appeal ? `<small>Оспаривание: ${escape(penalty.appeal.status)}${penalty.appeal.adminReply ? ` • ${escape(penalty.appeal.adminReply)}` : ""}</small>` : `<textarea data-appeal-message="${penalty.id}" placeholder="Объясните, почему штраф нужно пересмотреть"></textarea><button data-appeal="${penalty.id}">Оспорить штраф</button>`}</div>`).join("")}</article>`).join("") || `<article class="card">Сопровождений пока нет.</article>`}</div>`;
    target.querySelectorAll("[data-appeal]").forEach((button) => button.addEventListener("click", async () => {
      const message = target.querySelector(`[data-appeal-message="${button.dataset.appeal}"]`).value.trim();
      if (message.length < 10) return window.alert("Напишите объяснение минимум из 10 символов");
      button.disabled = true;
      const response = await fetch(`${base}/api/escort-portal/${encodeURIComponent(gameId)}/appeals`, { method: "POST", headers: { "content-type": "application/json", "x-player-code": code }, body: JSON.stringify({ penaltyId: button.dataset.appeal, message }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { button.disabled = false; return window.alert(result.error || "Ошибка отправки"); }
      await loadPlayer(gameId, code);
    }));
  }

  document.querySelector("#playerForm").addEventListener("submit", async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const status = document.querySelector("#playerStatus"); status.textContent = "";
    try { await loadPlayer(String(form.get("gameId")), String(form.get("code")).trim().toUpperCase()); } catch (error) { status.textContent = error.message; }
  });

  document.querySelector("#buyerForm").addEventListener("submit", async (event) => {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)); const status = document.querySelector("#buyerStatus"); status.textContent = "";
    try {
      const response = await fetch(`${base}/api/orders/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Заказ не найден");
      document.querySelector("#buyerResult").innerHTML = `<article class="card"><h2>${escape(data.item)}</h2><p>${escape(data.buyerName)} • ${new Date(data.orderDate).toLocaleDateString("ru-RU")}</p><div class="numbers"><span>${escape(statusLabels[data.status] || data.status)}</span><span>${money(data.amountUah)}</span></div><small>Заказ ${escape(data.id)}</small></article>`;
    } catch (error) { status.textContent = error.message; }
  });
})();
