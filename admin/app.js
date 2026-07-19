(() => {
  "use strict";

  const config = window.UNDYING_CONFIG || {};
  const apiBase = String(config.API_BASE_URL || "").replace(/\/$/, "");
  const loginView = document.querySelector("#loginView");
  const adminApp = document.querySelector("#adminApp");
  const loginForm = document.querySelector("#loginForm");
  const globalStatus = document.querySelector("#globalStatus");
  let csrfToken = sessionStorage.getItem("undying_admin_csrf") || "";
  let activeTicketId = null;
  const ticketStatuses = {
    open: "Новое",
    in_progress: "В работе",
    waiting_user: "Ожидает пользователя",
    closed: "Закрыто",
  };
  const ticketCategories = {
    purchase: "Покупка",
    payment: "Оплата",
    product_problem: "Проблема с товаром",
    partnership: "Сотрудничество",
    complaint: "Жалоба",
    other: "Другое",
  };

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
        ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Ошибка запроса");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function busy(form, state) {
    const button = form.querySelector("button[type=submit]");
    button.disabled = state;
    button.classList.toggle("is-loading", state);
  }

  function empty(title, note) {
    const box = document.createElement("div");
    box.className = "admin-empty";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = note;
    box.append(strong, small);
    return box;
  }

  function showLogin(message = "") {
    loginView.hidden = false;
    adminApp.hidden = true;
    document.querySelector("#loginStatus").textContent = message;
  }

  function showApp(dashboard) {
    loginView.hidden = true;
    adminApp.hidden = false;
    csrfToken = dashboard.csrfToken;
    sessionStorage.setItem("undying_admin_csrf", csrfToken);
    document.querySelector("#adminUsername").textContent = dashboard.admin.username;
    renderCounts(dashboard.counts);
  }

  function renderCounts(counts) {
    document.querySelector("#statReviews").textContent = counts.pendingReviews;
    document.querySelector("#statOpen").textContent = counts.openTickets;
    document.querySelector("#statProgress").textContent = counts.inProgressTickets;
    document.querySelector("#statApproved").textContent = counts.totalApprovedReviews;
    document.querySelector("#reviewBadge").textContent = counts.pendingReviews;
    document.querySelector("#ticketBadge").textContent = counts.openTickets;
  }

  async function bootstrap() {
    try {
      const dashboard = await api("/api/admin/dashboard", { method: "GET" });
      showApp(dashboard);
      await Promise.all([loadReviews(), loadTickets()]);
    } catch (error) {
      showLogin(error.status === 401 ? "" : error.message);
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    document.querySelector("#loginStatus").textContent = "";
    busy(loginForm, true);
    try {
      const payload = Object.fromEntries(new FormData(loginForm).entries());
      const result = await api("/api/admin/login", { method: "POST", body: JSON.stringify(payload) });
      csrfToken = result.csrfToken;
      sessionStorage.setItem("undying_admin_csrf", csrfToken);
      loginForm.reset();
      await bootstrap();
    } catch (error) {
      document.querySelector("#loginStatus").textContent = error.message;
    } finally {
      busy(loginForm, false);
    }
  });

  document.querySelector("#logoutButton").addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST", body: "{}" }); } catch {}
    csrfToken = "";
    sessionStorage.removeItem("undying_admin_csrf");
    showLogin();
  });

  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.adminTab);
    });
  });

  function activateTab(name) {
    document.querySelectorAll("[data-admin-tab]").forEach((item) => item.classList.toggle("is-active", item.dataset.adminTab === name));
    document.querySelectorAll("[data-admin-section]").forEach((section) => {
      const active = section.dataset.adminSection === name;
      section.hidden = !active;
      section.classList.toggle("is-active", active);
    });
  }

  function reviewElement(review) {
    const article = document.createElement("article");
    article.className = "admin-review";
    article.dataset.reviewId = review.id;
    const content = document.createElement("div");
    const head = document.createElement("div");
    head.className = "admin-review__head";
    const name = document.createElement("strong");
    name.textContent = review.name;
    const stars = document.createElement("span");
    stars.textContent = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
    head.append(name, stars);
    const text = document.createElement("p");
    text.textContent = review.text;
    const meta = document.createElement("small");
    meta.textContent = `${new Date(review.createdAt).toLocaleString("ru-RU")}${review.contact ? ` • ${review.contact}` : ""}`;
    content.append(head, text, meta);
    const actions = document.createElement("div");
    actions.className = "review-actions";
    const reply = document.createElement("textarea");
    reply.maxLength = 1200;
    reply.placeholder = "Официальный ответ магазина";
    reply.value = review.adminReply || "";
    const buttons = document.createElement("div");
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "Опубликовать";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.dataset.action = "reject";
    reject.textContent = "Отклонить";
    const update = async (status) => {
      try {
        await api(`/api/admin/reviews/${review.id}`, { method: "PATCH", body: JSON.stringify({ status, adminReply: reply.value }) });
        globalStatus.textContent = "Отзыв обновлён";
        await refreshAll();
      } catch (error) { globalStatus.textContent = error.message; }
    };
    approve.addEventListener("click", () => void update("approved"));
    reject.addEventListener("click", () => void update("rejected"));
    buttons.append(approve, reject);
    actions.append(reply, buttons);
    article.append(content, actions);
    return article;
  }

  async function loadReviews() {
    const container = document.querySelector("#adminReviews");
    container.replaceChildren(empty("Загрузка…", "Получаем отзывы"));
    try {
      const status = document.querySelector("#reviewFilter").value;
      const result = await api(`/api/admin/reviews?status=${encodeURIComponent(status)}&page=1&pageSize=50`, { method: "GET" });
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Отзывов нет", "Для выбранного статуса ничего не найдено."));
      result.items.forEach((review) => container.append(reviewElement(review)));
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  document.querySelector("#reviewFilter").addEventListener("change", () => void loadReviews());

  function ticketElement(ticket) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-ticket";
    button.classList.toggle("is-active", ticket.id === activeTicketId);
    const top = document.createElement("span");
    const number = document.createElement("strong");
    number.textContent = ticket.publicNumber;
    const status = document.createElement("em");
    status.textContent = ticketStatuses[ticket.status] || ticket.status;
    top.append(number, status);
    const subject = document.createElement("p");
    subject.textContent = ticket.subject;
    const meta = document.createElement("small");
    meta.textContent = `${ticket.name} • ${new Date(ticket.updatedAt).toLocaleString("ru-RU")}`;
    button.append(top, subject, meta);
    button.addEventListener("click", () => void loadTicketDetail(ticket.id));
    return button;
  }

  async function loadTickets() {
    const container = document.querySelector("#adminTickets");
    container.replaceChildren(empty("Загрузка…", "Получаем обращения"));
    try {
      const status = document.querySelector("#ticketFilter").value;
      const query = document.querySelector("#ticketSearch").value.trim();
      const result = await api(`/api/admin/tickets?status=${encodeURIComponent(status)}&query=${encodeURIComponent(query)}&page=1&pageSize=50`, { method: "GET" });
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Заявок нет", "Для выбранного фильтра ничего не найдено."));
      result.items.forEach((ticket) => container.append(ticketElement(ticket)));
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  let searchTimer;
  document.querySelector("#ticketSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadTickets(), 300);
  });
  document.querySelector("#ticketFilter").addEventListener("change", () => void loadTickets());

  async function loadTicketDetail(id) {
    const detail = document.querySelector("#adminTicketDetail");
    detail.replaceChildren(empty("Загрузка…", "Открываем переписку"));
    try {
      const ticket = await api(`/api/admin/tickets/${id}`, { method: "GET" });
      activeTicketId = id;
      renderTicketDetail(ticket);
      await loadTickets();
    } catch (error) { detail.replaceChildren(empty("Ошибка", error.message)); }
  }

  function renderTicketDetail(ticket) {
    const detail = document.querySelector("#adminTicketDetail");
    detail.replaceChildren();
    const head = document.createElement("div");
    head.className = "detail-head";
    const title = document.createElement("div");
    const h3 = document.createElement("h3");
    h3.textContent = ticket.publicNumber;
    const subject = document.createElement("p");
    subject.textContent = ticket.subject;
    title.append(h3, subject);
    const select = document.createElement("select");
    [["open","Новое"],["in_progress","В работе"],["waiting_user","Ожидает пользователя"],["closed","Закрыто"]].forEach(([value,label]) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; option.selected = ticket.status === value; select.append(option);
    });
    select.addEventListener("change", async () => {
      try { await api(`/api/admin/tickets/${ticket.id}/status`, { method: "PATCH", body: JSON.stringify({ status: select.value }) }); await refreshAll(); }
      catch (error) { globalStatus.textContent = error.message; }
    });
    head.append(title, select);
    const meta = document.createElement("div");
    meta.className = "detail-meta";
    [["Имя",ticket.name],["Контакт",ticket.contact],["Категория",ticketCategories[ticket.category] || ticket.category],["Создано",new Date(ticket.createdAt).toLocaleString("ru-RU")]].forEach(([label,value]) => {
      const item = document.createElement("span"); const small = document.createElement("small"); small.textContent=label; const strong=document.createElement("strong"); strong.textContent=value; item.append(small,strong); meta.append(item);
    });
    const messages = document.createElement("div");
    messages.className = "detail-messages";
    ticket.messages.forEach((item) => {
      const bubble = document.createElement("div");
      bubble.className = `detail-message detail-message--${item.senderType}`;
      bubble.textContent = item.message;
      const time = document.createElement("small"); time.textContent = `${item.senderType === "admin" ? "Администратор" : "Пользователь"} • ${new Date(item.createdAt).toLocaleString("ru-RU")}`; bubble.append(time); messages.append(bubble);
    });
    const form = document.createElement("form");
    form.className = "detail-reply";
    const textarea = document.createElement("textarea"); textarea.maxLength=3000; textarea.minLength=2; textarea.required=true; textarea.placeholder="Ответ пользователю";
    const button = document.createElement("button"); button.className="ticket-action"; button.type="submit"; button.textContent="Отправить ответ";
    form.append(textarea,button);
    form.hidden = ticket.status === "closed";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try { await api(`/api/admin/tickets/${ticket.id}/messages`, { method:"POST", body:JSON.stringify({message:textarea.value}) }); await loadTicketDetail(ticket.id); await refreshDashboard(); }
      catch (error) { globalStatus.textContent=error.message; }
    });
    detail.append(head, meta, messages, form);
  }

  async function refreshDashboard() {
    const dashboard = await api("/api/admin/dashboard", { method: "GET" });
    csrfToken = dashboard.csrfToken;
    sessionStorage.setItem("undying_admin_csrf", csrfToken);
    renderCounts(dashboard.counts);
  }

  async function refreshAll() {
    globalStatus.textContent = "";
    await Promise.all([refreshDashboard(), loadReviews(), loadTickets()]);
    if (activeTicketId) await loadTicketDetail(activeTicketId);
  }

  async function applyDeepLink() {
    const parameters = new URLSearchParams(window.location.search);
    const section = parameters.get("section");
    const id = parameters.get("id");
    if (section === "tickets") {
      activateTab("tickets");
      if (id) await loadTicketDetail(id);
      return;
    }
    if (section === "reviews") {
      activateTab("reviews");
      const review = [...document.querySelectorAll("[data-review-id]")].find((item) => item.dataset.reviewId === id);
      review?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  document.querySelector("#refreshButton").addEventListener("click", () => void refreshAll());
  void bootstrap().then(() => adminApp.hidden ? undefined : applyDeepLink());
})();
