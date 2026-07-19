(() => {
  "use strict";

  const config = window.UNDYING_CONFIG || {};
  const navigation = window.UNDYING_NAVIGATION;
  const apiBase = String(config.API_BASE_URL || "").replace(/\/$/, "");
  const managers = Array.isArray(config.MANAGERS)
    ? config.MANAGERS.map((manager) => ({ ...manager, telegramUrl: normalizeTelegramUrl(manager.telegramUrl) }))
    : [];
  const managerByKey = new Map(managers.map((manager) => [manager.key, manager]));
  const modal = document.querySelector("#managersModal");
  const cards = [...document.querySelectorAll("[data-manager-key]")];
  const message = document.querySelector("#managersMessage");
  const states = new Map();

  let lastFocusedElement = null;
  let serverOffset = 0;
  let refreshTimer = 0;
  let countdownTimer = 0;

  function normalizeTelegramUrl(value) {
    const input = String(value || "").trim();
    if (/^@[a-zA-Z0-9_]{5,32}$/.test(input)) return `https://t.me/${input.slice(1)}`;
    if (/^[a-zA-Z0-9_]{5,32}$/.test(input)) return `https://t.me/${input}`;
    try {
      const url = new URL(input);
      return url.protocol === "https:" && ["t.me", "telegram.me"].includes(url.hostname.toLowerCase()) ? url.href : "";
    } catch {
      return "";
    }
  }

  function endpoint(path) {
    if (!apiBase) throw new Error("Не удалось проверить статус менеджеров");
    return `${apiBase}${path}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(endpoint(path), {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Не удалось обновить статус менеджера");
      error.data = data;
      throw error;
    }
    return data;
  }

  function setMessage(text = "", state = "") {
    message.textContent = text;
    message.dataset.state = state;
  }

  function serverNow() {
    return Date.now() + serverOffset;
  }

  function remainingLabel(busyUntil) {
    const seconds = Math.max(0, Math.ceil((busyUntil - serverNow()) / 1000));
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const rest = String(seconds % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  function configureCards() {
    cards.forEach((card) => {
      const manager = managerByKey.get(card.dataset.managerKey);
      if (!manager) return;
      card.querySelector("[data-manager-name]").textContent = manager.name;
      card.querySelector("[data-manager-specialty]").textContent = manager.specialty;
      const avatar = card.querySelector("[data-manager-avatar]");
      avatar.src = manager.avatar;
      avatar.alt = `Аватар: ${manager.name}`;
      card.querySelector("[data-manager-contact]").dataset.transitionLabel = manager.name;
    });
  }

  function renderCard(card) {
    const key = card.dataset.managerKey;
    const manager = managerByKey.get(key);
    const state = states.get(key) || { status: "unknown", busyUntil: null };
    const status = card.querySelector("[data-manager-status] b");
    const action = card.querySelector("[data-manager-action]");
    const button = card.querySelector("[data-manager-contact]");
    const fallback = card.querySelector("[data-manager-fallback]");
    const busy = state.status === "busy" && state.busyUntil > serverNow();
    const loading = card.classList.contains("is-claiming");
    fallback.hidden = true;

    if (busy) {
      card.dataset.status = "busy";
      status.textContent = "Занят";
      action.textContent = `Освободится через ${remainingLabel(state.busyUntil)}`;
      button.disabled = true;
      return;
    }

    if (state.status === "unavailable") {
      card.dataset.status = "unavailable";
      status.textContent = "Нет связи";
      action.textContent = "Статус временно недоступен";
      button.disabled = true;
      fallback.hidden = !manager?.telegramUrl;
      return;
    }

    if (state.status === "available" || (state.status === "busy" && !busy)) {
      state.status = "available";
      state.busyUntil = null;
      states.set(key, state);
      card.dataset.status = "available";
      status.textContent = "Свободен";
      if (loading) {
        action.textContent = "Подключаем…";
        button.disabled = true;
      } else if (!manager?.telegramUrl) {
        action.textContent = "Telegram скоро появится";
        button.disabled = true;
      } else {
        action.textContent = "Написать в Telegram";
        button.disabled = false;
      }
      return;
    }

    card.dataset.status = "unknown";
    status.textContent = "Нет данных";
    action.textContent = "Статус недоступен";
    button.disabled = true;
  }

  function renderAll() {
    cards.forEach(renderCard);
  }

  async function loadStatuses({ quiet = false } = {}) {
    if (!quiet) setMessage("Проверяем свободных менеджеров…");
    try {
      const result = await api("/api/managers", { method: "GET" });
      serverOffset = new Date(result.serverTime).getTime() - Date.now();
      result.items.forEach((item) => {
        states.set(item.key, {
          status: item.status,
          busyUntil: item.busyUntil ? new Date(item.busyUntil).getTime() : null,
        });
      });
      setMessage("");
      renderAll();
    } catch (error) {
      managers.forEach((manager) => states.set(manager.key, { status: "unavailable", busyUntil: null }));
      if (!quiet) setMessage("Не удалось проверить статус менеджеров. Telegram можно открыть напрямую.", "error");
      renderAll();
    }
  }

  async function claimManager(card) {
    const key = card.dataset.managerKey;
    const manager = managerByKey.get(key);
    if (!manager?.telegramUrl || !navigation?.isSafeDestination(manager.telegramUrl)) {
      setMessage("Ссылка на Telegram этого менеджера временно недоступна.", "error");
      return;
    }

    card.classList.add("is-claiming");
    renderCard(card);
    setMessage("Бронируем линию связи на 10 минут…");
    try {
      const result = await api(`/api/managers/${encodeURIComponent(key)}/claim`, {
        method: "POST",
        body: "{}",
      });
      states.set(key, { status: "busy", busyUntil: new Date(result.busyUntil).getTime() });
      renderAll();
      closeModal();
      window.setTimeout(() => navigation.openWithTransition(manager.telegramUrl, card.querySelector("[data-manager-contact]")), 80);
    } catch (error) {
      if (error.data?.busyUntil) {
        states.set(key, { status: "busy", busyUntil: new Date(error.data.busyUntil).getTime() });
      } else {
        states.set(key, { status: "unavailable", busyUntil: null });
      }
      setMessage(
        error.data?.busyUntil
          ? error.message
          : "Не удалось проверить статус менеджера. Можно открыть Telegram напрямую.",
        "error",
      );
    } finally {
      card.classList.remove("is-claiming");
      renderAll();
    }
  }

  function openTelegramDirectly(card) {
    const manager = managerByKey.get(card.dataset.managerKey);
    if (!manager?.telegramUrl || !navigation?.isSafeDestination(manager.telegramUrl)) return;
    closeModal();
    window.setTimeout(() => navigation.openWithTransition(manager.telegramUrl, card.querySelector("[data-manager-contact]")), 80);
  }

  function openModal() {
    lastFocusedElement = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    setMessage("");
    void loadStatuses();
    window.clearInterval(refreshTimer);
    window.clearInterval(countdownTimer);
    refreshTimer = window.setInterval(() => void loadStatuses({ quiet: true }), 15_000);
    countdownTimer = window.setInterval(renderAll, 1_000);
    window.setTimeout(() => modal.querySelector("[data-managers-close]")?.focus(), 120);
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    window.clearInterval(refreshTimer);
    window.clearInterval(countdownTimer);
    if (!document.querySelector("#communityModal.is-open")) document.body.classList.remove("modal-open");
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
  }

  document.querySelectorAll("[data-managers-open]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      openModal();
    });
  });
  document.querySelectorAll("[data-managers-close]").forEach((button) => button.addEventListener("click", closeModal));
  cards.forEach((card) => card.querySelector("[data-manager-contact]").addEventListener("click", () => void claimManager(card)));
  cards.forEach((card) => card.querySelector("[data-manager-fallback]").addEventListener("click", () => openTelegramDirectly(card)));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  });

  configureCards();
  renderAll();
})();
