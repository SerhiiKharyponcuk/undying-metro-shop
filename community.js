(() => {
  "use strict";

  const config = window.UNDYING_CONFIG || {};
  const apiBase = String(config.API_BASE_URL || "").replace(/\/$/, "");
  const modal = document.querySelector("#communityModal");
  const panel = modal?.querySelector(".community-panel");
  const views = [...document.querySelectorAll("[data-community-view]")];
  const tabs = [...document.querySelectorAll(".community-tab")];
  const reviewsList = document.querySelector("#reviewsList");
  const reviewsMore = document.querySelector("#reviewsMore");
  const reviewForm = document.querySelector("#reviewForm");
  const supportForm = document.querySelector("#supportForm");
  const lookupForm = document.querySelector("#ticketLookupForm");
  const replyForm = document.querySelector("#ticketReplyForm");
  const success = document.querySelector("#communitySuccess");
  const lastTicketButton = document.querySelector("#lastTicketButton");
  const savedTicketKey = "undying_support_ticket";
  const statusLabels = {
    open: "Новое",
    in_progress: "В работе",
    waiting_user: "Ожидает ответа",
    closed: "Закрыто",
  };

  let activeTicket = null;
  let reviewPage = 1;
  let reviewTotal = 0;
  let reviewCount = 0;
  let lastFocusedElement = null;
  const turnstileWidgets = new Map();
  let turnstileLoader;

  function endpoint(path) {
    if (!apiBase) throw new Error("Сервис временно недоступен. Попробуйте немного позже.");
    return `${apiBase}${path}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(endpoint(path), {
      credentials: "include",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Не удалось выполнить запрос");
    return data;
  }

  function setStatus(name, message = "", state = "") {
    const element = document.querySelector(`[data-form-status="${name}"]`);
    if (!element) return;
    element.textContent = message;
    element.dataset.state = state;
  }

  function setBusy(form, busy) {
    const button = form.querySelector("button[type=submit]");
    form.setAttribute("aria-busy", String(busy));
    if (button) {
      button.disabled = busy;
      button.classList.toggle("is-loading", busy);
    }
  }

  function switchView(name) {
    success.hidden = true;
    views.forEach((view) => {
      const active = view.dataset.communityView === name;
      view.hidden = !active;
      view.classList.toggle("is-active", active);
    });
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.communityTab === name));
    const ticketTab = document.querySelector(".community-tab--ticket");
    if (ticketTab) ticketTab.hidden = name !== "ticket";
    panel?.scrollTo({ top: 0, behavior: "smooth" });
    if (name === "reviews") void loadReviews(true);
    if (name === "support") refreshSavedTicket();
    void prepareTurnstile(name);
  }

  function openModal(name) {
    lastFocusedElement = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    switchView(name);
    window.setTimeout(() => modal.querySelector("[data-community-close]")?.focus(), 120);
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus();
  }

  document.querySelectorAll("[data-community]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      openModal(button.dataset.community);
    });
  });
  document.querySelectorAll("[data-community-close]").forEach((button) => button.addEventListener("click", closeModal));
  document.querySelectorAll("[data-community-tab]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.communityTab));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  });

  function reviewCard(review) {
    const article = document.createElement("article");
    article.className = "review-card";
    const head = document.createElement("div");
    head.className = "review-card__head";
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = review.name;
    const date = document.createElement("small");
    date.textContent = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(review.createdAt));
    identity.append(name, date);
    const stars = document.createElement("span");
    stars.className = "review-card__stars";
    stars.textContent = `${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}`;
    head.append(identity, stars);
    const text = document.createElement("p");
    text.textContent = review.text;
    article.append(head, text);
    if (review.adminReply) {
      const reply = document.createElement("div");
      reply.className = "review-card__reply";
      const label = document.createElement("strong");
      label.textContent = "Ответ Undying Metro Shop";
      const replyText = document.createElement("p");
      replyText.textContent = review.adminReply;
      reply.append(label, replyText);
      article.append(reply);
    }
    return article;
  }

  async function loadReviews(reset = false) {
    if (reset) {
      reviewPage = 1;
      reviewCount = 0;
      reviewsList.replaceChildren();
    }
    reviewsList.classList.add("is-loading");
    if (reset) reviewsList.textContent = "Загружаем отзывы…";
    try {
      const result = await api(`/api/reviews?page=${reviewPage}&pageSize=6`, { method: "GET", headers: {} });
      if (reset) reviewsList.replaceChildren();
      reviewTotal = result.total;
      reviewCount += result.items.length;
      if (reviewTotal === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.innerHTML = "<strong>Пока нет опубликованных отзывов</strong><small>Стань первым, кто поделится впечатлением.</small>";
        reviewsList.append(empty);
      } else {
        result.items.forEach((review) => reviewsList.append(reviewCard(review)));
      }
      reviewsMore.hidden = reviewCount >= reviewTotal;
      reviewPage += 1;
    } catch (error) {
      reviewsList.replaceChildren();
      const failure = document.createElement("div");
      failure.className = "empty-state empty-state--error";
      const title = document.createElement("strong");
      title.textContent = "Отзывы временно недоступны";
      const note = document.createElement("small");
      note.textContent = error.message;
      failure.append(title, note);
      reviewsList.append(failure);
      reviewsMore.hidden = true;
    } finally {
      reviewsList.classList.remove("is-loading");
    }
  }
  reviewsMore?.addEventListener("click", () => void loadReviews(false));

  function formPayload(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  reviewForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("review");
    if (!reviewForm.reportValidity()) return;
    setBusy(reviewForm, true);
    try {
      const payload = formPayload(reviewForm);
      payload.rating = Number(payload.rating);
      await api("/api/reviews", { method: "POST", body: JSON.stringify(payload) });
      reviewForm.reset();
      resetTurnstile("review");
      showSuccess({
        eyebrow: "ОТЗЫВ ПРИНЯТ",
        title: "Спасибо за доверие",
        text: "Отзыв отправлен на модерацию. После проверки администратора он появится на сайте.",
        action: "Вернуться к отзывам",
        onAction: () => switchView("reviews"),
      });
    } catch (error) {
      setStatus("review", error.message, "error");
    } finally {
      setBusy(reviewForm, false);
    }
  });

  supportForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("support");
    if (!supportForm.reportValidity()) return;
    setBusy(supportForm, true);
    try {
      const result = await api("/api/support/tickets", { method: "POST", body: JSON.stringify(formPayload(supportForm)) });
      saveTicket({ number: result.number, token: result.token });
      supportForm.reset();
      resetTurnstile("support");
      showSuccess({
        eyebrow: "ЗАЯВКА ЗАРЕГИСТРИРОВАНА",
        title: "Обращение создано",
        text: "Секретный ключ сохранён в этом браузере. Не публикуйте его и не передавайте посторонним.",
        ticket: { number: result.number, token: result.token },
        action: "Открыть заявку",
        onAction: () => void openTicket(result.number, result.token),
      });
    } catch (error) {
      setStatus("support", error.message, "error");
    } finally {
      setBusy(supportForm, false);
    }
  });

  lookupForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("lookup");
    const payload = formPayload(lookupForm);
    try {
      await openTicket(String(payload.number).trim().toUpperCase(), String(payload.token));
    } catch (error) {
      setStatus("lookup", error.message, "error");
    }
  });

  replyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeTicket || !replyForm.reportValidity()) return;
    setBusy(replyForm, true);
    setStatus("reply");
    try {
      const payload = formPayload(replyForm);
      await api(`/api/support/tickets/${encodeURIComponent(activeTicket.number)}/messages`, {
        method: "POST",
        headers: { "x-ticket-token": activeTicket.token },
        body: JSON.stringify(payload),
      });
      replyForm.reset();
      await openTicket(activeTicket.number, activeTicket.token);
    } catch (error) {
      setStatus("reply", error.message, "error");
    } finally {
      setBusy(replyForm, false);
    }
  });

  async function openTicket(number, token) {
    const ticket = await api(`/api/support/tickets/${encodeURIComponent(number)}`, {
      method: "GET",
      headers: { "x-ticket-token": token },
    });
    activeTicket = { number, token, data: ticket };
    saveTicket({ number, token });
    renderTicket(ticket);
    switchView("ticket");
  }

  function renderTicket(ticket) {
    document.querySelector("#ticketNumber").textContent = ticket.number;
    document.querySelector("#ticketSubject").textContent = ticket.subject;
    const status = document.querySelector("#ticketStatus");
    status.textContent = statusLabels[ticket.status] || ticket.status;
    status.dataset.status = ticket.status;
    const messages = document.querySelector("#ticketMessages");
    messages.replaceChildren();
    ticket.messages.forEach((item) => {
      const bubble = document.createElement("article");
      bubble.className = `ticket-message ticket-message--${item.sender}`;
      const label = document.createElement("strong");
      label.textContent = item.sender === "admin" ? "Менеджер Undying" : "Вы";
      const text = document.createElement("p");
      text.textContent = item.message;
      const date = document.createElement("time");
      date.textContent = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(item.createdAt));
      bubble.append(label, text, date);
      messages.append(bubble);
    });
    replyForm.hidden = ticket.status === "closed";
  }

  function saveTicket(ticket) {
    localStorage.setItem(savedTicketKey, JSON.stringify(ticket));
    refreshSavedTicket();
  }

  function savedTicket() {
    try {
      const value = JSON.parse(localStorage.getItem(savedTicketKey));
      return value?.number && value?.token ? value : null;
    } catch {
      return null;
    }
  }

  function refreshSavedTicket() {
    const ticket = savedTicket();
    lastTicketButton.hidden = !ticket;
    if (ticket) document.querySelector("#lastTicketNumber").textContent = ticket.number;
  }

  lastTicketButton?.addEventListener("click", async () => {
    const ticket = savedTicket();
    if (!ticket) return;
    try {
      await openTicket(ticket.number, ticket.token);
    } catch (error) {
      setStatus("support", error.message, "error");
    }
  });

  function showSuccess({ eyebrow, title, text, ticket, action, onAction }) {
    views.forEach((view) => {
      view.hidden = true;
      view.classList.remove("is-active");
    });
    success.hidden = false;
    success.querySelector("small").textContent = eyebrow;
    document.querySelector("#successTitle").textContent = title;
    document.querySelector("#successText").textContent = text;
    const credential = document.querySelector("#credentialCard");
    credential.hidden = !ticket;
    if (ticket) document.querySelector("#successTicketNumber").textContent = ticket.number;
    const button = document.querySelector("#successAction");
    button.textContent = action;
    button.onclick = onAction;
    document.querySelector("#copyTicketData").onclick = async () => {
      if (!ticket) return;
      await navigator.clipboard.writeText(`Номер: ${ticket.number}\nСекретный ключ: ${ticket.token}`);
      document.querySelector("#copyTicketData").textContent = "Скопировано";
    };
    panel?.scrollTo({ top: 0, behavior: "smooth" });
  }

  document.querySelectorAll("textarea[maxlength]").forEach((textarea) => {
    const counter = textarea.parentElement.querySelector(`[data-counter-for="${textarea.name}"]`);
    const update = () => { if (counter) counter.textContent = `${textarea.value.length} / ${textarea.maxLength}`; };
    textarea.addEventListener("input", update);
    update();
  });

  supportForm?.elements.contactType.addEventListener("change", () => {
    supportForm.elements.contact.placeholder = supportForm.elements.contactType.value === "email" ? "name@example.com" : "@username";
  });

  async function loadTurnstile() {
    if (!config.TURNSTILE_SITE_KEY) return null;
    if (window.turnstile) return window.turnstile;
    if (turnstileLoader) return turnstileLoader;
    turnstileLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => reject(new Error("Не удалось загрузить защиту от спама"));
      document.head.append(script);
    });
    return turnstileLoader;
  }

  async function prepareTurnstile(view) {
    if (!["reviews", "support"].includes(view) || !config.TURNSTILE_SITE_KEY) return;
    const key = view === "reviews" ? "review" : "support";
    if (turnstileWidgets.has(key)) return;
    try {
      const turnstile = await loadTurnstile();
      const slot = document.querySelector(`[data-turnstile="${key}"]`);
      const form = key === "review" ? reviewForm : supportForm;
      const widget = turnstile.render(slot, {
        sitekey: config.TURNSTILE_SITE_KEY,
        theme: "dark",
        callback: (token) => { form.elements.turnstileToken.value = token; },
        "expired-callback": () => { form.elements.turnstileToken.value = ""; },
      });
      turnstileWidgets.set(key, widget);
    } catch (error) {
      setStatus(key, error.message, "error");
    }
  }

  function resetTurnstile(key) {
    const widget = turnstileWidgets.get(key);
    if (widget !== undefined && window.turnstile) window.turnstile.reset(widget);
  }

  refreshSavedTicket();
})();
