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
  let accessMode = "observer";
  let heartbeatRunning = false;
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
  const escortStatuses = {
    planned: "Запланировано",
    completed: "Завершено",
    paid: "Выплачено",
    cancelled: "Отменено",
  };
  const escortForm = document.querySelector("#escortForm");
  const escortPeople = document.querySelector("#escortPeople");
  let rateWasLoadedFromNbu = false;

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
      error.code = data.code || "";
      if (error.code === "ADMIN_READ_ONLY") applyAccessMode("observer");
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

  function canWrite() {
    return accessMode === "operator";
  }

  function applyAccessMode(mode) {
    const nextMode = mode === "observer" ? "observer" : "operator";
    const changed = nextMode !== accessMode;
    accessMode = nextMode;
    adminApp.dataset.accessMode = accessMode;
    const observer = !canWrite();
    document.querySelector("#adminAccessBadge").textContent = observer ? "Наблюдатель" : "Управление";
    document.querySelector("#adminAccessTitle").textContent = observer ? "Режим наблюдения" : "Режим управления";
    document.querySelector("#adminAccessDescription").textContent = observer
      ? "Другой администратор управляет панелью. Вы можете следить за всеми данными; доступ к изменениям перейдёт автоматически."
      : "Вы первый активный администратор и можете вносить изменения. Остальные администраторы подключаются как наблюдатели.";
    document.querySelector("#adminAccessNotice").dataset.mode = accessMode;
    escortForm.inert = observer;
    document.querySelectorAll("[data-write-control]").forEach((control) => {
      control.disabled = observer || control.dataset.writeBlocked === "true";
    });
    return changed;
  }

  function writeControl(control, blocked = false) {
    control.dataset.writeControl = "true";
    control.dataset.writeBlocked = String(Boolean(blocked));
    control.disabled = !canWrite() || blocked;
    return control;
  }

  function showLogin(message = "") {
    loginView.hidden = false;
    adminApp.hidden = true;
    applyAccessMode("observer");
    document.querySelector("#loginStatus").textContent = message;
  }

  function showApp(dashboard) {
    loginView.hidden = true;
    adminApp.hidden = false;
    csrfToken = dashboard.csrfToken;
    sessionStorage.setItem("undying_admin_csrf", csrfToken);
    document.querySelector("#adminUsername").textContent = dashboard.admin.username;
    applyAccessMode(dashboard.accessMode === "observer" || dashboard.canWrite === false ? "observer" : "operator");
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
      await Promise.all([loadReviews(), loadTickets(), loadEscortOrders()]);
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

  function money(value) {
    const amount = Number(String(value || "0").replace(",", "."));
    return Number.isFinite(amount) ? `${amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₴` : "0,00 ₴";
  }

  function addEscortRow(name = "", contact = "") {
    if (escortPeople.children.length >= 3) return;
    const row = document.createElement("div");
    row.className = "escort-person";
    const number = document.createElement("b");
    const nameLabel = document.createElement("label");
    nameLabel.innerHTML = "<span>Имя игрока</span>";
    const nameInput = document.createElement("input");
    nameInput.name = "escortName";
    nameInput.minLength = 2;
    nameInput.maxLength = 64;
    nameInput.required = true;
    nameInput.value = name;
    nameLabel.append(nameInput);
    const contactLabel = document.createElement("label");
    contactLabel.innerHTML = "<span>Telegram / контакт</span>";
    const contactInput = document.createElement("input");
    contactInput.name = "escortContact";
    contactInput.maxLength = 128;
    contactInput.value = contact;
    contactLabel.append(contactInput);
    const remove = document.createElement("button");
    remove.className = "escort-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить игрока");
    remove.addEventListener("click", () => {
      if (escortPeople.children.length <= 1) return;
      row.remove();
      renumberEscorts();
      updateEscortPreview();
    });
    row.append(number, nameLabel, contactLabel, remove);
    escortPeople.append(row);
    renumberEscorts();
    updateEscortPreview();
  }

  function renumberEscorts() {
    [...escortPeople.children].forEach((row, index) => { row.querySelector("b").textContent = String(index + 1); });
    document.querySelector("#addEscort").disabled = escortPeople.children.length >= 3;
  }

  function updateEscortPreview() {
    const amount = Number(String(escortForm.elements.amount.value || "0").replace(",", "."));
    const rate = Number(String(escortForm.elements.exchangeRate.value || "0").replace(",", "."));
    const total = Number.isFinite(amount * rate) ? Math.round(amount * rate * 100) / 100 : 0;
    const director = Math.round(total * 3) / 100;
    const creator = Math.round(total * 10) / 100;
    const pool = Math.round((total - director - creator) * 100) / 100;
    const share = escortPeople.children.length ? Math.floor((pool / escortPeople.children.length) * 100) / 100 : 0;
    document.querySelector("#previewTotal").textContent = money(total);
    document.querySelector("#previewDirector").textContent = money(director);
    document.querySelector("#previewCreator").textContent = money(creator);
    document.querySelector("#previewPool").textContent = money(pool);
    document.querySelector("#previewShare").textContent = money(share);
  }

  async function loadNbuRate() {
    const currency = escortForm.elements.currency.value;
    const date = escortForm.elements.orderDate.value;
    const status = document.querySelector("#escortFormStatus");
    if (currency === "UAH") {
      escortForm.elements.exchangeRate.value = "1";
      rateWasLoadedFromNbu = false;
      updateEscortPreview();
      return;
    }
    if (!date) return;
    status.textContent = "Получаем официальный курс НБУ…";
    try {
      const result = await api(`/api/admin/exchange-rate?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(date)}`, { method: "GET" });
      escortForm.elements.exchangeRate.value = result.rate;
      rateWasLoadedFromNbu = true;
      status.textContent = `Курс НБУ: 1 ${currency} = ${result.rate} ₴`;
      updateEscortPreview();
    } catch (error) {
      rateWasLoadedFromNbu = false;
      status.textContent = `${error.message}. Курс можно указать вручную.`;
    }
  }

  document.querySelector("#addEscort").addEventListener("click", () => addEscortRow());
  document.querySelector("#loadNbuRate").addEventListener("click", () => void loadNbuRate());
  escortForm.elements.currency.addEventListener("change", () => {
    const foreign = escortForm.elements.currency.value !== "UAH";
    document.querySelector("#loadNbuRate").disabled = !foreign;
    escortForm.elements.exchangeRate.readOnly = !foreign;
    if (!foreign) {
      escortForm.elements.exchangeRate.value = "1";
      rateWasLoadedFromNbu = false;
      updateEscortPreview();
    } else {
      void loadNbuRate();
    }
  });
  escortForm.elements.orderDate.addEventListener("change", () => {
    if (escortForm.elements.currency.value !== "UAH") void loadNbuRate();
  });
  escortForm.elements.amount.addEventListener("input", updateEscortPreview);
  escortForm.elements.exchangeRate.addEventListener("input", () => { rateWasLoadedFromNbu = false; updateEscortPreview(); });

  escortForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.querySelector("#escortFormStatus");
    status.textContent = "";
    busy(escortForm, true);
    try {
      const escorts = [...escortPeople.children].map((row) => ({
        name: row.querySelector('[name="escortName"]').value,
        contact: row.querySelector('[name="escortContact"]').value,
      }));
      const payload = {
        item: escortForm.elements.purchaseItem.value,
        buyerName: escortForm.elements.buyerName.value,
        buyerContact: escortForm.elements.buyerContact.value,
        amount: escortForm.elements.amount.value,
        currency: escortForm.elements.currency.value,
        exchangeRate: rateWasLoadedFromNbu ? "" : escortForm.elements.exchangeRate.value,
        orderDate: escortForm.elements.orderDate.value,
        escorts,
      };
      await api("/api/admin/escort-orders", { method: "POST", body: JSON.stringify(payload) });
      status.textContent = "Расчёт сопровождения сохранён";
      escortForm.reset();
      escortForm.elements.orderDate.value = new Date().toISOString().slice(0, 10);
      escortForm.elements.exchangeRate.value = "1";
      escortForm.elements.exchangeRate.readOnly = true;
      document.querySelector("#loadNbuRate").disabled = true;
      rateWasLoadedFromNbu = false;
      escortPeople.replaceChildren();
      addEscortRow();
      await loadEscortOrders();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy(escortForm, false);
    }
  });

  function escortOrderElement(order) {
    const article = document.createElement("article");
    article.className = "escort-order";
    const head = document.createElement("div");
    head.className = "escort-order__head";
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = order.item;
    const meta = document.createElement("p");
    meta.textContent = `${order.buyerName}${order.buyerContact ? ` • ${order.buyerContact}` : ""} • ${new Date(order.orderDate).toLocaleDateString("ru-RU")}`;
    heading.append(title, meta);
    const statusSelect = document.createElement("select");
    writeControl(statusSelect);
    Object.entries(escortStatuses).forEach(([value, label]) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; option.selected = order.status === value; statusSelect.append(option);
    });
    statusSelect.addEventListener("change", async () => {
      try { await api(`/api/admin/escort-orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status: statusSelect.value }) }); await loadEscortOrders(); }
      catch (error) { globalStatus.textContent = error.message; }
    });
    head.append(heading, statusSelect);
    const values = document.createElement("div");
    values.className = "escort-order__money";
    [
      ["Оплачено", `${order.originalAmount} ${order.currency}`],
      ["В гривне", money(order.amountUah)],
      ["Директору 3%", money(order.directorAmountUah)],
      ["Создателю 10%", money(order.creatorAmountUah)],
      ["Игрокам", money(order.escortPoolUah)],
      ["Штрафы в банк", money(order.bankFromPenaltiesUah)],
    ].forEach(([label, value]) => {
      const box = document.createElement("span"); const small = document.createElement("small"); small.textContent = label; const strong = document.createElement("strong"); strong.textContent = value; box.append(small, strong); values.append(box);
    });
    const players = document.createElement("div");
    players.className = "escort-order__players";
    order.participants.forEach((player) => {
      const row = document.createElement("article");
      row.className = `escort-player${player.replacedAt ? " is-replaced" : ""}${player.excludedAt && !player.replacedAt ? " is-excluded" : ""}`;
      const top = document.createElement("div"); top.className = "escort-player__top";
      const person = document.createElement("span");
      const name = document.createElement("strong"); name.textContent = player.name;
      const note = document.createElement("small");
      note.textContent = `${player.contact || "Без контакта"}${player.replacedAt ? " • Заменён" : ""}${player.excludedAt && !player.replacedAt ? " • Исключён после 4 нарушения" : ""}${player.replacementForId ? " • Вышел на замену" : ""}`;
      person.append(name, note);
      const label = document.createElement("label");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = player.paid; writeControl(checkbox, Boolean(player.replacedAt));
      const paymentText = document.createElement("span"); paymentText.textContent = player.replacedAt ? "Доля передана" : (player.paid ? "Выплачено" : "Отметить выплату");
      label.append(checkbox, paymentText);
      checkbox.addEventListener("change", async () => {
        checkbox.disabled = true;
        try { await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}`, { method: "PATCH", body: JSON.stringify({ paid: checkbox.checked }) }); await loadEscortOrders(); }
        catch (error) { checkbox.checked = !checkbox.checked; checkbox.disabled = !canWrite() || Boolean(player.replacedAt); globalStatus.textContent = error.message; }
      });
      top.append(person, label);

      const figures = document.createElement("div"); figures.className = "escort-player__figures";
      [["Исходная доля", player.shareUah], ["Удержано", player.penaltyTotalUah], ["К выплате", player.payoutUah]].forEach(([caption, value]) => {
        const figure = document.createElement("span"); figure.textContent = `${caption}: `; const amount = document.createElement("b"); amount.textContent = money(value); figure.append(amount); figures.append(figure);
      });

      const penalties = document.createElement("div"); penalties.className = "escort-player__penalties";
      player.penalties.forEach((penalty) => {
        const item = document.createElement("p");
        item.textContent = `Штраф ${penalty.sequence}: −${penalty.percentage}% (${money(penalty.amountUah)}) • ${penalty.reason}`;
        penalties.append(item);
      });

      row.append(top, figures, penalties);
      if (canWrite() && !player.replacedAt && !player.paid) {
        const details = document.createElement("details"); details.className = "escort-actions";
        const summary = document.createElement("summary"); summary.textContent = player.excludedAt ? "Игрок исключён — назначить замену" : "Штраф или замена игрока";
        const actions = document.createElement("div"); actions.className = "escort-action-grid";

        const penaltyForm = document.createElement("form"); penaltyForm.className = "escort-mini-form escort-mini-form--penalty";
        const penaltyCaption = document.createElement("span"); penaltyCaption.textContent = player.nextPenaltyPercent ? `Следующая ступень: −${player.nextPenaltyPercent}% от доли` : "Все ступени штрафов применены";
        const reason = document.createElement("input"); reason.placeholder = "Причина нарушения"; reason.minLength = 3; reason.maxLength = 300; reason.required = true;
        const penalize = document.createElement("button"); penalize.type = "submit"; penalize.disabled = !player.nextPenaltyPercent; penalize.textContent = player.nextPenaltyPercent ? `Штраф −${player.nextPenaltyPercent}%` : "Лимит штрафов";
        penaltyForm.append(penaltyCaption, reason, penalize);
        penaltyForm.addEventListener("submit", async (event) => {
          event.preventDefault(); penalize.disabled = true;
          try {
            await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}/penalties`, { method: "POST", body: JSON.stringify({ reason: reason.value }) });
            globalStatus.textContent = "Штраф зафиксирован и зачислен в банк Metro Shop";
            await loadEscortOrders();
          } catch (error) { globalStatus.textContent = error.message; penalize.disabled = false; }
        });

        const replacementForm = document.createElement("form"); replacementForm.className = "escort-mini-form escort-mini-form--replacement";
        const replacementCaption = document.createElement("span"); replacementCaption.textContent = "Передать оставшуюся долю новому игроку";
        const replacementName = document.createElement("input"); replacementName.placeholder = "Имя нового игрока"; replacementName.minLength = 2; replacementName.maxLength = 64; replacementName.required = true;
        const replacementContact = document.createElement("input"); replacementContact.placeholder = "Telegram / контакт"; replacementContact.maxLength = 128;
        const replace = document.createElement("button"); replace.type = "submit"; replace.textContent = "Заменить";
        replacementForm.append(replacementCaption, replacementName, replacementContact, replace);
        replacementForm.addEventListener("submit", async (event) => {
          event.preventDefault(); replace.disabled = true;
          try {
            await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}/replacement`, { method: "POST", body: JSON.stringify({ name: replacementName.value, contact: replacementContact.value }) });
            globalStatus.textContent = "Игрок заменён, оставшаяся доля передана";
            await loadEscortOrders();
          } catch (error) { globalStatus.textContent = error.message; replace.disabled = false; }
        });
        actions.append(penaltyForm, replacementForm); details.append(summary, actions); row.append(details);
      }
      players.append(row);
    });
    article.append(head, values, players);
    return article;
  }

  async function loadEscortOrders() {
    const container = document.querySelector("#escortOrders");
    container.replaceChildren(empty("Загрузка…", "Получаем историю сопровождений"));
    try {
      const status = document.querySelector("#escortFilter").value;
      const [result, bank] = await Promise.all([
        api(`/api/admin/escort-orders?status=${encodeURIComponent(status)}&page=1&pageSize=50`, { method: "GET" }),
        api("/api/admin/shop-bank", { method: "GET" }),
      ]);
      container.replaceChildren();
      document.querySelector("#shopBankBalance").textContent = money(bank.penaltyBalanceUah);
      document.querySelector("#directorBankBalance").textContent = money(bank.directorBalanceUah);
      document.querySelector("#creatorBankBalance").textContent = money(bank.creatorBalanceUah);
      document.querySelector("#escortHistoryTotal").textContent = `Записей: ${result.total}`;
      if (!result.items.length) container.append(empty("Сопровождений пока нет", "Создайте первый расчёт выше."));
      result.items.forEach((order) => container.append(escortOrderElement(order)));
    } catch (error) {
      container.replaceChildren(empty("Ошибка загрузки", error.message));
    }
  }

  document.querySelector("#escortFilter").addEventListener("change", () => void loadEscortOrders());
  escortForm.elements.orderDate.value = new Date().toISOString().slice(0, 10);
  escortForm.elements.exchangeRate.readOnly = true;
  addEscortRow();

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
    writeControl(reply);
    reply.maxLength = 1200;
    reply.placeholder = "Официальный ответ магазина";
    reply.value = review.adminReply || "";
    const buttons = document.createElement("div");
    const approve = document.createElement("button");
    writeControl(approve);
    approve.type = "button";
    approve.textContent = "Опубликовать";
    const reject = document.createElement("button");
    writeControl(reject);
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
    writeControl(select);
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
    const textarea = document.createElement("textarea"); textarea.maxLength=3000; textarea.minLength=2; textarea.required=true; textarea.placeholder="Ответ пользователю"; writeControl(textarea);
    const button = document.createElement("button"); button.className="ticket-action"; button.type="submit"; button.textContent="Отправить ответ"; writeControl(button);
    form.append(textarea,button);
    form.hidden = ticket.status === "closed" || !canWrite();
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
    const changed = applyAccessMode(dashboard.accessMode === "observer" || dashboard.canWrite === false ? "observer" : "operator");
    renderCounts(dashboard.counts);
    return changed;
  }

  async function refreshAll() {
    globalStatus.textContent = "";
    await refreshDashboard();
    await Promise.all([loadReviews(), loadTickets(), loadEscortOrders()]);
    if (activeTicketId) await loadTicketDetail(activeTicketId);
  }

  async function refreshActiveSection() {
    const activeTab = document.querySelector("[data-admin-tab].is-active")?.dataset.adminTab;
    if (activeTab === "tickets") {
      await loadTickets();
      if (activeTicketId) await loadTicketDetail(activeTicketId);
      return;
    }
    if (activeTab === "escorts") {
      await loadEscortOrders();
      return;
    }
    await loadReviews();
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
      return;
    }
    if (section === "escorts") {
      activateTab("escorts");
    }
  }

  document.querySelector("#refreshButton").addEventListener("click", () => void refreshAll());
  window.setInterval(async () => {
    if (adminApp.hidden || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const changed = await refreshDashboard();
      if (changed) {
        globalStatus.textContent = canWrite()
          ? "Управление панелью автоматически передано вам"
          : "Панель переключена в режим наблюдения";
      }
      await refreshActiveSection();
    } catch (error) {
      if (error.status === 401) {
        csrfToken = "";
        sessionStorage.removeItem("undying_admin_csrf");
        showLogin("Сессия истекла");
      }
    } finally {
      heartbeatRunning = false;
    }
  }, 20_000);
  void bootstrap().then(() => adminApp.hidden ? undefined : applyDeepLink());
})();
