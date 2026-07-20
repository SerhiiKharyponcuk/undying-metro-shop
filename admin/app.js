(() => {
  "use strict";

  const config = window.UNDYING_CONFIG || {};
  const apiBase = String(config.API_BASE_URL || "").replace(/\/$/, "");
  const loginView = document.querySelector("#loginView");
  const adminApp = document.querySelector("#adminApp");
  const loginForm = document.querySelector("#loginForm");
  const globalStatus = document.querySelector("#globalStatus");

  function storageGet(kind, key) {
    try { return window[kind]?.getItem(key) || ""; } catch { return ""; }
  }

  function storageSet(kind, key, value) {
    try { window[kind]?.setItem(key, value); } catch {}
  }

  function storageRemove(kind, key) {
    try { window[kind]?.removeItem(key); } catch {}
  }

  let csrfToken = storageGet("sessionStorage", "undying_admin_csrf");
  let adminAuthToken = storageGet("localStorage", "undying_admin_token");
  let activeTicketId = null;
  let accessMode = "observer";
  let currentRole = "observer";
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
        ...(options.body !== undefined && options.body !== null ? { "content-type": "application/json" } : {}),
        ...(adminAuthToken ? { authorization: `Bearer ${adminAuthToken}` } : {}),
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

  async function copyText(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function decodeBase64url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=").slice(0));
    return Uint8Array.from(bytes, (character) => character.charCodeAt(0)).buffer;
  }

  function encodeBase64url(value) {
    const bytes = new Uint8Array(value || new ArrayBuffer(0));
    let binary = ""; bytes.forEach((item) => { binary += String.fromCharCode(item); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function registrationOptions(options) {
    return { ...options, challenge: decodeBase64url(options.challenge), user: { ...options.user, id: decodeBase64url(options.user.id) }, excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: decodeBase64url(item.id) })) };
  }

  function authenticationOptions(options) {
    return { ...options, challenge: decodeBase64url(options.challenge), allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: decodeBase64url(item.id) })) };
  }

  function credentialJson(credential) {
    const response = credential.response;
    const value = { id: credential.id, rawId: encodeBase64url(credential.rawId), type: credential.type, authenticatorAttachment: credential.authenticatorAttachment, clientExtensionResults: credential.getClientExtensionResults(), response: { clientDataJSON: encodeBase64url(response.clientDataJSON) } };
    if (response.attestationObject) { value.response.attestationObject = encodeBase64url(response.attestationObject); value.response.transports = response.getTransports ? response.getTransports() : []; }
    if (response.authenticatorData) { value.response.authenticatorData = encodeBase64url(response.authenticatorData); value.response.signature = encodeBase64url(response.signature); value.response.userHandle = response.userHandle ? encodeBase64url(response.userHandle) : undefined; }
    return value;
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

  function clearSession() {
    csrfToken = "";
    adminAuthToken = "";
    storageRemove("sessionStorage", "undying_admin_csrf");
    storageRemove("localStorage", "undying_admin_token");
  }

  function showApp(dashboard) {
    loginView.hidden = true;
    adminApp.hidden = false;
    csrfToken = dashboard.csrfToken;
    storageSet("sessionStorage", "undying_admin_csrf", csrfToken);
    document.querySelector("#adminUsername").textContent = dashboard.admin.username;
    currentRole = dashboard.admin.role || "admin";
    document.querySelector("#accountsTab").hidden = currentRole !== "owner";
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
    document.querySelector("#completedBadge").textContent = counts.completedEscortOrders;
  }

  async function bootstrap(afterLogin = false) {
    try {
      const dashboard = await api("/api/admin/dashboard", { method: "GET" });
      showApp(dashboard);
      await Promise.all([loadReviews(), loadTickets(), loadEscortOrders(), loadCompletedEscorts(), loadPlayerProfiles(), loadPenalties(), loadFinancialReport(), loadAuditLogs(), currentRole === "owner" ? loadAccounts() : Promise.resolve()]);
    } catch (error) {
      const blockedCookieMessage = "Вход не сохранился. Откройте защищённую админку по адресу undying-metro-api.onrender.com/admin/ и повторите вход.";
      showLogin(error.status === 401 ? (afterLogin ? blockedCookieMessage : "") : error.message);
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
      adminAuthToken = result.sessionToken || "";
      storageSet("sessionStorage", "undying_admin_csrf", csrfToken);
      if (adminAuthToken) storageSet("localStorage", "undying_admin_token", adminAuthToken);
      loginForm.reset();
      document.querySelector("#otpField").hidden = true;
      loginForm.elements.otp.required = false;
      await bootstrap(true);
    } catch (error) {
      if (error.code === "OTP_REQUIRED" || error.code === "OTP_INVALID") {
        document.querySelector("#otpField").hidden = false;
        loginForm.elements.otp.required = true;
        loginForm.elements.otp.focus();
      }
      document.querySelector("#loginStatus").textContent = error.message;
    } finally {
      busy(loginForm, false);
    }
  });

  document.querySelector("#logoutButton").addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST", body: "{}" }); } catch {}
    clearSession();
    showLogin();
  });

  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      activateTab(button.dataset.adminTab);
      if (button.dataset.adminTab === "completed") void loadCompletedEscorts();
      if (button.dataset.adminTab === "calendar") void loadCalendar();
      if (button.dataset.adminTab === "archive") void loadArchivedEscorts();
      if (button.dataset.adminTab === "players") void loadPlayerProfiles();
      if (button.dataset.adminTab === "penalties") void loadPenalties();
      if (button.dataset.adminTab === "appeals") void loadAppeals();
      if (button.dataset.adminTab === "payments") void loadPayments();
      if (button.dataset.adminTab === "reports") void loadFinancialReport();
      if (button.dataset.adminTab === "analytics") void loadAnalytics();
      if (button.dataset.adminTab === "audit") void loadAuditLogs();
      if (button.dataset.adminTab === "accounts") void loadAccounts();
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

  function addEscortRow(name = "", gameId = "", contact = "") {
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
    const gameIdLabel = document.createElement("label");
    gameIdLabel.innerHTML = "<span>PUBG ID игрока</span>";
    const gameIdInput = document.createElement("input");
    gameIdInput.name = "escortGameId";
    gameIdInput.inputMode = "numeric";
    gameIdInput.pattern = "[0-9]{5,20}";
    gameIdInput.minLength = 5;
    gameIdInput.maxLength = 20;
    gameIdInput.required = true;
    gameIdInput.value = gameId;
    gameIdLabel.append(gameIdInput);
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
    row.append(number, nameLabel, gameIdLabel, contactLabel, remove);
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
        gameId: row.querySelector('[name="escortGameId"]').value,
        contact: row.querySelector('[name="escortContact"]').value,
      }));
      const payload = {
        item: escortForm.elements.purchaseItem.value,
        buyerName: escortForm.elements.buyerName.value,
        buyerContact: escortForm.elements.buyerContact.value,
        buyerGameId: escortForm.elements.buyerGameId.value,
        amount: escortForm.elements.amount.value,
        currency: escortForm.elements.currency.value,
        exchangeRate: rateWasLoadedFromNbu ? "" : escortForm.elements.exchangeRate.value,
        orderDate: escortForm.elements.orderDate.value,
        escorts,
      };
      const created = await api("/api/admin/escort-orders", { method: "POST", body: JSON.stringify(payload) });
      status.textContent = `Расчёт сохранён. Одноразовый код покупателя: ${created.reviewCode}`;
      escortForm.reset();
      escortForm.elements.orderDate.value = new Date().toISOString().slice(0, 10);
      escortForm.elements.exchangeRate.value = "1";
      escortForm.elements.exchangeRate.readOnly = true;
      document.querySelector("#loadNbuRate").disabled = true;
      rateWasLoadedFromNbu = false;
      escortPeople.replaceChildren();
      addEscortRow();
      await Promise.all([loadEscortOrders(), loadCompletedEscorts(), refreshDashboard()]);
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
    meta.textContent = [
      order.buyerName,
      order.buyerGameId ? `PUBG ID ${order.buyerGameId}` : "",
      order.buyerContact || "",
      new Date(order.orderDate).toLocaleDateString("ru-RU"),
    ].filter(Boolean).join(" • ");
    heading.append(title, meta);
    const statusSelect = document.createElement("select");
    writeControl(statusSelect);
    Object.entries(escortStatuses).forEach(([value, label]) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; option.selected = order.status === value; statusSelect.append(option);
    });
    statusSelect.addEventListener("change", async () => {
      try {
        await api(`/api/admin/escort-orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status: statusSelect.value }) });
        if (statusSelect.value === "cancelled") globalStatus.textContent = "Заказ отменён и скрыт из списка сопровождений";
        await Promise.all([loadEscortOrders(), loadCompletedEscorts(), refreshDashboard()]);
      } catch (error) { globalStatus.textContent = error.message; }
    });
    const headActions = document.createElement("div");
    headActions.className = "escort-order__actions";
    const reviewCodeButton = document.createElement("button");
    reviewCodeButton.type = "button";
    reviewCodeButton.textContent = order.reviewCodeConsumedAt ? "Отзыв оставлен" : "Выдать новый код отзыва";
    writeControl(reviewCodeButton, Boolean(order.reviewCodeConsumedAt));
    reviewCodeButton.addEventListener("click", async () => {
      try {
        const updated = await api(`/api/admin/escort-orders/${order.id}/review-code`, { method: "POST", body: "{}" });
        globalStatus.textContent = `Новый одноразовый код для ${order.buyerName}: ${updated.reviewCode}`;
      } catch (error) { globalStatus.textContent = error.message; }
    });
    headActions.append(statusSelect, reviewCodeButton);
    head.append(heading, headActions);
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
      const restriction = player.permanentlyBanned
        ? " • Постоянный бан"
        : player.suspendedUntil && new Date(player.suspendedUntil) > new Date()
          ? ` • Отстранён до ${new Date(player.suspendedUntil).toLocaleString("ru-RU")}`
          : "";
      note.textContent = `PUBG ID ${player.playerGameId || "не указан"} • ${player.contact || "Без контакта"}${restriction}${player.replacedAt ? " • Заменён" : ""}${player.replacementForId ? " • Вышел на замену" : ""}`;
      person.append(name, note);
      const label = document.createElement("label");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = player.paid; writeControl(checkbox, Boolean(player.replacedAt));
      const paymentText = document.createElement("span"); paymentText.textContent = player.replacedAt ? "Доля передана" : (player.paid ? "Выплачено" : "Отметить выплату");
      label.append(checkbox, paymentText);
      const assignment = document.createElement("select"); assignment.setAttribute("aria-label", `Статус назначения ${player.name}`); writeControl(assignment, Boolean(player.replacedAt));
      [["invited", "Приглашён"], ["accepted", "Принял"], ["declined", "Отказался"]].forEach(([value, text]) => {
        const option = document.createElement("option"); option.value = value; option.textContent = text; option.selected = (player.assignmentStatus || "invited") === value; assignment.append(option);
      });
      assignment.addEventListener("change", async () => {
        assignment.disabled = true;
        try {
          await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}/assignment`, { method: "PATCH", body: JSON.stringify({ status: assignment.value }) });
          await Promise.all([loadEscortOrders(), loadCompletedEscorts(), loadArchivedEscorts()]);
        } catch (error) { globalStatus.textContent = error.message; assignment.disabled = false; }
      });
      checkbox.addEventListener("change", async () => {
        checkbox.disabled = true;
        try {
          const method = checkbox.checked ? (window.prompt("Способ выплаты (карта, криптовалюта, наличные)", "Карта") || "") : "";
          const note = checkbox.checked ? (window.prompt("Комментарий к выплате (необязательно)", "") || "") : "";
          await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}`, { method: "PATCH", body: JSON.stringify({ paid: checkbox.checked, method, note }) });
          await Promise.all([loadEscortOrders(), loadPayments(), loadPlayerProfiles()]);
        }
        catch (error) { checkbox.checked = !checkbox.checked; checkbox.disabled = !canWrite() || Boolean(player.replacedAt); globalStatus.textContent = error.message; }
      });
      top.append(person, assignment, label);

      const figures = document.createElement("div"); figures.className = "escort-player__figures";
      [["Исходная доля", player.shareUah], ["Удержано", player.penaltyTotalUah], ["К выплате", player.payoutUah]].forEach(([caption, value]) => {
        const figure = document.createElement("span"); figure.textContent = `${caption}: `; const amount = document.createElement("b"); amount.textContent = money(value); figure.append(amount); figures.append(figure);
      });

      const penalties = document.createElement("div"); penalties.className = "escort-player__penalties";
      player.penalties.forEach((penalty) => {
        const item = document.createElement("p");
        item.textContent = penalty.percentage
          ? `Нарушение ${penalty.sequence}: −${penalty.percentage}% (${money(penalty.amountUah)}) • ${penalty.reason}`
          : `Нарушение ${penalty.sequence}: постоянная блокировка • ${penalty.reason}`;
        penalties.append(item);
      });

      row.append(top, figures, penalties);
      if (canWrite() && !player.replacedAt && !player.paid) {
        const details = document.createElement("details"); details.className = "escort-actions";
        const summary = document.createElement("summary"); summary.textContent = player.permanentlyBanned ? "Игрок заблокирован — назначить замену" : player.suspendedUntil ? "Игрок отстранён — нарушение или замена" : "Нарушение или замена игрока";
        const actions = document.createElement("div"); actions.className = "escort-action-grid";

        const penaltyForm = document.createElement("form"); penaltyForm.className = "escort-mini-form escort-mini-form--penalty";
        const penaltyCaption = document.createElement("span"); penaltyCaption.textContent = player.nextViolationAction === "permanent_ban"
          ? "Следующее, 5-е нарушение за день: постоянный бан"
          : player.nextPenaltyPercent ? `Следующая ступень: −${player.nextPenaltyPercent}% от доли` : "Все нарушения за сегодня зафиксированы";
        const reason = document.createElement("input"); reason.placeholder = "Причина нарушения"; reason.minLength = 3; reason.maxLength = 300; reason.required = true;
        const penalize = document.createElement("button"); penalize.type = "submit"; penalize.disabled = !player.nextViolationAction; penalize.textContent = player.nextViolationAction === "permanent_ban" ? "Зафиксировать 5-е нарушение" : player.nextPenaltyPercent ? `Штраф −${player.nextPenaltyPercent}%` : "Лимит нарушений";
        penaltyForm.append(penaltyCaption, reason, penalize);
        penaltyForm.addEventListener("submit", async (event) => {
          event.preventDefault(); penalize.disabled = true;
          try {
            await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}/penalties`, { method: "POST", body: JSON.stringify({ reason: reason.value }) });
            globalStatus.textContent = "Штраф зафиксирован и зачислен в банк Metro Shop";
            await Promise.all([loadEscortOrders(), loadPenalties(), loadPlayerProfiles()]);
          } catch (error) { globalStatus.textContent = error.message; penalize.disabled = false; }
        });

        const replacementForm = document.createElement("form"); replacementForm.className = "escort-mini-form escort-mini-form--replacement";
        const replacementCaption = document.createElement("span"); replacementCaption.textContent = "Передать оставшуюся долю новому игроку";
        const replacementName = document.createElement("input"); replacementName.placeholder = "Имя нового игрока"; replacementName.minLength = 2; replacementName.maxLength = 64; replacementName.required = true;
        const replacementGameId = document.createElement("input"); replacementGameId.placeholder = "PUBG ID нового игрока"; replacementGameId.inputMode = "numeric"; replacementGameId.pattern = "[0-9]{5,20}"; replacementGameId.required = true;
        const replacementContact = document.createElement("input"); replacementContact.placeholder = "Telegram / контакт"; replacementContact.maxLength = 128;
        const replace = document.createElement("button"); replace.type = "submit"; replace.textContent = "Заменить";
        replacementForm.append(replacementCaption, replacementName, replacementGameId, replacementContact, replace);
        replacementForm.addEventListener("submit", async (event) => {
          event.preventDefault(); replace.disabled = true;
          try {
            await api(`/api/admin/escort-orders/${order.id}/participants/${player.id}/replacement`, { method: "POST", body: JSON.stringify({ name: replacementName.value, gameId: replacementGameId.value, contact: replacementContact.value }) });
            globalStatus.textContent = "Игрок заменён, оставшаяся доля передана";
        await Promise.all([loadEscortOrders(), loadCompletedEscorts(), loadArchivedEscorts(), refreshDashboard()]);
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

  async function loadCompletedEscorts() {
    const container = document.querySelector("#completedEscortOrders");
    container.replaceChildren(empty("Загрузка…", "Получаем выполненные сопровождения"));
    try {
      const [completed, paid] = await Promise.all([
        api("/api/admin/escort-orders?status=completed&page=1&pageSize=50", { method: "GET" }),
        api("/api/admin/escort-orders?status=paid&page=1&pageSize=50", { method: "GET" }),
      ]);
      const items = [...completed.items, ...paid.items]
        .sort((left, right) => new Date(right.orderDate) - new Date(left.orderDate));
      container.replaceChildren();
      if (!items.length) {
        container.append(empty("Выполненных сопровождений пока нет", "После смены статуса на «Завершено» или «Выплачено» заказ появится здесь."));
      }
      items.forEach((order) => container.append(escortOrderElement(order)));
    } catch (error) {
      container.replaceChildren(empty("Ошибка загрузки", error.message));
    }
  }

  async function loadArchivedEscorts() {
    const container = document.querySelector("#archivedEscortOrders");
    if (!container) return;
    container.replaceChildren(empty("Загрузка…", "Получаем отменённые сопровождения"));
    try {
      const result = await api("/api/admin/escort-orders?status=cancelled&page=1&pageSize=50", { method: "GET" });
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Архив пуст", "Отменённые сопровождения появятся здесь."));
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
    meta.textContent = [
      new Date(review.createdAt).toLocaleString("ru-RU"),
      review.buyerGameId ? `PUBG ID ${review.buyerGameId}` : "",
      review.contact || "",
    ].filter(Boolean).join(" • ");
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

  function profileElement(profile) {
    const card = document.createElement("article");
    card.className = `profile-card${profile.permanentlyBanned ? " is-banned" : profile.suspendedUntil && new Date(profile.suspendedUntil) > new Date() ? " is-suspended" : ""}`;
    const title = document.createElement("h3"); title.textContent = profile.displayName;
    const meta = document.createElement("p"); meta.textContent = `PUBG ID ${profile.gameId}${profile.contact ? ` • ${profile.contact}` : ""}`;
    const status = document.createElement("strong");
    status.textContent = profile.permanentlyBanned ? "Постоянный бан" : profile.suspendedUntil && new Date(profile.suspendedUntil) > new Date()
      ? `Отстранён до ${new Date(profile.suspendedUntil).toLocaleString("ru-RU")}` : "Допущен к сопровождениям";
    const figures = document.createElement("div"); figures.className = "profile-card__figures";
    [["Заказов", profile.orderCount], ["Нарушений", profile.penaltyCount], ["Начислено", money(profile.earnedUah)], ["Удержано", money(profile.withheldUah)], ["Выплачено", money(profile.paidUah)], ["Баланс", money(profile.balanceUah)]].forEach(([label, value]) => {
      const item = document.createElement("span"); item.innerHTML = `<small>${label}</small><b>${value}</b>`; figures.append(item);
    });
    card.append(title, meta, status, figures);
    if (canWrite()) {
      const access = document.createElement("button"); access.type = "button"; access.textContent = "Выдать код кабинета"; writeControl(access);
      const portalBox = document.createElement("div");
      portalBox.className = "portal-code-card";
      portalBox.hidden = true;
      access.addEventListener("click", async () => {
        access.disabled = true;
        try {
          const result = await api(`/api/admin/player-profiles/${profile.id}/portal-code`, { method: "POST", body: "{}" });
          const portalUrl = `${window.location.origin}/portal.html`;
          const message = [
            "Кабинет сопровождающего Undying Metro",
            `Ссылка: ${portalUrl}`,
            `PUBG ID: ${result.gameId}`,
            `Код: ${result.code}`,
          ].join("\n");
          const code = document.createElement("code");
          code.textContent = result.code;
          const details = document.createElement("textarea");
          details.readOnly = true;
          details.value = message;
          const copyCode = document.createElement("button");
          copyCode.type = "button";
          copyCode.textContent = "Копировать код";
          const copyAll = document.createElement("button");
          copyAll.type = "button";
          copyAll.textContent = "Копировать всё";
          copyCode.addEventListener("click", async () => {
            await copyText(result.code);
            globalStatus.textContent = "Код кабинета скопирован";
          });
          copyAll.addEventListener("click", async () => {
            await copyText(message);
            globalStatus.textContent = "Сообщение для игрока скопировано";
          });
          portalBox.replaceChildren(code, details, copyCode, copyAll);
          portalBox.hidden = false;
          globalStatus.textContent = `Код кабинета для PUBG ID ${result.gameId} создан`;
          access.textContent = "Выдать новый код";
          access.disabled = !canWrite();
        } catch (error) { globalStatus.textContent = error.message; access.disabled = false; }
      });
      card.append(access, portalBox);
    }
    return card;
  }

  async function loadPlayerProfiles() {
    const container = document.querySelector("#playerProfiles");
    if (!container) return;
    container.replaceChildren(empty("Загрузка…", "Получаем профили игроков"));
    try {
      const query = document.querySelector("#playerSearch").value.trim();
      const result = await api(`/api/admin/player-profiles?query=${encodeURIComponent(query)}&page=1&pageSize=100`, { method: "GET" });
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Игроки не найдены", "Профили создаются при добавлении сопровождающих."));
      result.items.forEach((profile) => container.append(profileElement(profile)));
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  function penaltyElement(penalty) {
    const card = document.createElement("article");
    card.className = "penalty-management-card";
    const content = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = `${penalty.participantName}${penalty.playerGameId ? ` • PUBG ID ${penalty.playerGameId}` : ""}`;
    const meta = document.createElement("p");
    meta.textContent = `${penalty.orderItem} • Покупатель: ${penalty.buyerName} • ${new Date(penalty.createdAt).toLocaleString("ru-RU")}`;
    const reason = document.createElement("strong");
    reason.textContent = penalty.percentage
      ? `Нарушение ${penalty.sequence}: −${penalty.percentage}% (${money(penalty.amountUah)}) — ${penalty.reason}`
      : `Нарушение ${penalty.sequence}: постоянная блокировка — ${penalty.reason}`;
    const author = document.createElement("small");
    author.textContent = `Добавил: ${penalty.createdByUsername}`;
    content.append(title, meta, reason, author);
    card.append(content);
    if (canWrite()) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "penalty-delete";
      remove.textContent = "Удалить штраф";
      writeControl(remove);
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Удалить штраф игрока ${penalty.participantName}? Проценты и блокировка будут пересчитаны.`)) return;
        remove.disabled = true;
        try {
          try {
            await api(`/api/admin/penalties/${penalty.id}`, { method: "DELETE", body: JSON.stringify({ clearPaid: false }) });
          } catch (error) {
            const needsPaymentReset = error.message.includes("Сначала снимите отметку о выплате");
            if (!needsPaymentReset || !window.confirm(`Игрок ${penalty.participantName} отмечен выплаченным. Снять отметку о выплате и удалить штраф?`)) throw error;
            await api(`/api/admin/penalties/${penalty.id}`, { method: "DELETE", body: JSON.stringify({ clearPaid: true }) });
          }
          globalStatus.textContent = "Штраф удалён, выплаты и ограничения пересчитаны";
          await Promise.all([loadPenalties(), loadEscortOrders(), loadPlayerProfiles(), loadFinancialReport(), loadAuditLogs()]);
        } catch (error) {
          globalStatus.textContent = error.message;
          remove.disabled = false;
        }
      });
      card.append(remove);
    }
    return card;
  }

  async function loadPenalties() {
    const container = document.querySelector("#adminPenalties");
    if (!container) return;
    container.replaceChildren(empty("Загрузка…", "Получаем журнал штрафов"));
    try {
      const query = document.querySelector("#penaltySearch").value.trim();
      const result = await api(`/api/admin/penalties?query=${encodeURIComponent(query)}&page=1&pageSize=100`, { method: "GET" });
      document.querySelector("#penaltyBadge").textContent = result.total;
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Штрафов нет", "Здесь появятся зафиксированные нарушения сопровождающих."));
      result.items.forEach((penalty) => container.append(penaltyElement(penalty)));
    } catch (error) {
      container.replaceChildren(empty("Ошибка загрузки", error.message));
    }
  }

  async function loadAppeals() {
    const container = document.querySelector("#penaltyAppeals");
    if (!container) return;
    const status = document.querySelector("#appealFilter").value;
    container.replaceChildren(empty("Загрузка…", "Получаем оспаривания штрафов"));
    try {
      const result = await api(`/api/admin/penalty-appeals?status=${encodeURIComponent(status)}`, { method: "GET" });
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Оспариваний нет", "Новые обращения игроков появятся здесь."));
      result.items.forEach((appeal) => {
        const card = document.createElement("article"); card.className = "penalty-management-card";
        const content = document.createElement("div");
        const title = document.createElement("h3"); title.textContent = `${appeal.playerName} • PUBG ID ${appeal.gameId}`;
        const meta = document.createElement("p"); meta.textContent = `Штраф ${money(appeal.penaltyAmountUah)} • ${appeal.penaltyReason} • ${new Date(appeal.createdAt).toLocaleString("ru-RU")}`;
        const message = document.createElement("strong"); message.textContent = appeal.message;
        content.append(title, meta, message);
        if (appeal.adminReply) { const reply = document.createElement("small"); reply.textContent = `Ответ: ${appeal.adminReply}`; content.append(reply); }
        card.append(content);
        if (appeal.status === "pending" && canWrite()) {
          const controls = document.createElement("div");
          [["approved", "Одобрить"], ["rejected", "Отклонить"]].forEach(([decision, label]) => {
            const button = document.createElement("button"); button.type = "button"; button.textContent = label; writeControl(button);
            button.addEventListener("click", async () => {
              const adminReply = window.prompt("Ответ игроку", decision === "approved" ? "Оспаривание принято. Администратор проверит снятие штрафа." : "Штраф оставлен в силе.") || "";
              if (!adminReply) return;
              await api(`/api/admin/penalty-appeals/${appeal.id}`, { method: "PATCH", body: JSON.stringify({ status: decision, adminReply }) });
              await loadAppeals();
            });
            controls.append(button);
          });
          card.append(controls);
        }
        container.append(card);
      });
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  function reportDates() {
    const today = new Date().toISOString().slice(0, 10);
    const month = `${today.slice(0, 8)}01`;
    const from = document.querySelector("#reportFrom");
    const to = document.querySelector("#reportTo");
    if (!from.value) from.value = month;
    if (!to.value) to.value = today;
    return { from: from.value, to: to.value };
  }

  async function loadFinancialReport() {
    const container = document.querySelector("#financialReport");
    if (!container) return;
    const { from, to } = reportDates();
    try {
      const report = await api(`/api/admin/reports/financial?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "GET" });
      container.replaceChildren();
      [["Заказов", report.orderCount], ["Оборот", money(report.grossUah)], ["Директор 3%", money(report.directorUah)], ["Создатель 10%", money(report.creatorUah)],
        ["Фонд игроков", money(report.escortPoolUah)], ["Штрафы", money(report.penaltiesUah)], ["Выплачено", money(report.paidToEscortsUah)], ["Ожидает выплаты", money(report.unpaidToEscortsUah)]].forEach(([label, value]) => {
        const card = document.createElement("article"); const small = document.createElement("small"); small.textContent = label; const strong = document.createElement("strong"); strong.textContent = value; card.append(small, strong); container.append(card);
      });
    } catch (error) { container.replaceChildren(empty("Ошибка отчёта", error.message)); }
  }

  async function downloadFinancialReport() {
    const { from, to } = reportDates();
    try {
      const response = await fetch(endpoint(`/api/admin/reports/financial.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`), { credentials: "include", headers: adminAuthToken ? { authorization: `Bearer ${adminAuthToken}` } : {} });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Не удалось скачать отчёт");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `financial-${from}-${to}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (error) { globalStatus.textContent = error.message; }
  }

  function saveDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function downloadBackup() {
    try {
      const response = await fetch(endpoint("/api/admin/backups/latest"), { credentials: "include", headers: adminAuthToken ? { authorization: `Bearer ${adminAuthToken}` } : {} });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Не удалось создать резервную копию");
      saveDownload(await response.blob(), `undying-metro-backup-${new Date().toISOString().slice(0, 10)}.json`);
      globalStatus.textContent = "Резервная копия подготовлена";
    } catch (error) { globalStatus.textContent = error.message; }
  }

  async function restoreBackup(file) {
    if (currentRole !== "owner") { globalStatus.textContent = "Восстановление доступно только владельцу"; return; }
    const confirmation = window.prompt("ВНИМАНИЕ: текущие операционные данные будут заменены. Введите RESTORE");
    if (confirmation !== "RESTORE") return;
    try {
      const backup = JSON.parse(await file.text());
      await api("/api/admin/backups/restore", { method: "POST", body: JSON.stringify({ confirmation, backup }) });
      globalStatus.textContent = "Резервная копия восстановлена";
      await refreshAll();
    } catch (error) { globalStatus.textContent = error.message; }
  }

  async function clearEscortOperations() {
    if (currentRole !== "owner") { globalStatus.textContent = "Очистка тестовых заказов доступна только владельцу"; return; }
    const confirmation = window.prompt("Будут удалены все сопровождения, выплаты, штрафы и оспаривания. Введите DELETE TEST ORDERS");
    if (confirmation !== "DELETE TEST ORDERS") return;
    try {
      const result = await api("/api/admin/escort-operations", { method: "DELETE", body: JSON.stringify({ confirmation }) });
      globalStatus.textContent = `Очищено: заказов ${result.cleared.orders}, выплат/записей журнала ${result.cleared.auditLogs}`;
      await refreshAll();
    } catch (error) { globalStatus.textContent = error.message; }
  }

  async function loadPayments() {
    const container = document.querySelector("#paymentHistory");
    if (!container) return;
    container.replaceChildren(empty("Загрузка…", "Получаем историю выплат"));
    try {
      const result = await api("/api/admin/audit-logs?page=1&pageSize=100", { method: "GET" });
      const payments = result.items.filter((item) => item.action === "escort_participant.payment_changed");
      container.replaceChildren();
      if (!payments.length) container.append(empty("Выплат пока нет", "Все отметки выплат и отмены появятся здесь."));
      payments.forEach((event) => {
        const card = document.createElement("article"); card.className = "audit-card";
        const title = document.createElement("strong");
        title.textContent = event.details?.paid ? `Выплата: ${event.details?.participantName || "игрок"}` : `Выплата отменена: ${event.details?.participantName || "игрок"}`;
        const meta = document.createElement("p");
        meta.textContent = `${event.details?.payoutUah ? money(event.details.payoutUah) : ""}${event.details?.method ? ` • ${event.details.method}` : ""}${event.details?.note ? ` • ${event.details.note}` : ""} • ${event.adminUsername || "Система"} • ${new Date(event.createdAt).toLocaleString("ru-RU")}`;
        card.append(title, meta);
        if (canWrite() && event.details?.paid && event.details?.orderId && event.entityId) {
          const reverse = document.createElement("button"); reverse.type = "button"; reverse.textContent = "Отменить выплату"; writeControl(reverse);
          reverse.addEventListener("click", async () => {
            if (!window.confirm("Снять отметку выплаты у этого игрока?")) return;
            try {
              await api(`/api/admin/escort-orders/${event.details.orderId}/participants/${event.entityId}`, { method: "PATCH", body: JSON.stringify({ paid: false }) });
              await Promise.all([loadPayments(), loadEscortOrders(), loadCompletedEscorts()]);
            } catch (error) { globalStatus.textContent = error.message; }
          });
          card.append(reverse);
        }
        container.append(card);
      });
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  async function loadCalendar() {
    const container = document.querySelector("#escortCalendar");
    if (!container) return;
    const fromInput = document.querySelector("#calendarFrom");
    const toInput = document.querySelector("#calendarTo");
    const today = new Date().toISOString().slice(0, 10);
    if (!fromInput.value) fromInput.value = `${today.slice(0, 8)}01`;
    if (!toInput.value) toInput.value = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10);
    container.replaceChildren(empty("Загрузка…", "Получаем календарь сопровождений"));
    try {
      const [active, cancelled] = await Promise.all([
        api("/api/admin/escort-orders?page=1&pageSize=50", { method: "GET" }),
        api("/api/admin/escort-orders?status=cancelled&page=1&pageSize=50", { method: "GET" }),
      ]);
      const orders = [...active.items, ...cancelled.items]
        .filter((order) => order.orderDate.slice(0, 10) >= fromInput.value && order.orderDate.slice(0, 10) <= toInput.value)
        .sort((left, right) => left.orderDate.localeCompare(right.orderDate));
      container.replaceChildren();
      if (!orders.length) container.append(empty("Заказов нет", "Измените период календаря"));
      let previousDate = "";
      orders.forEach((order) => {
        const date = order.orderDate.slice(0, 10);
        if (date !== previousDate) {
          const heading = document.createElement("h3"); heading.textContent = new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" }); container.append(heading); previousDate = date;
        }
        const card = document.createElement("article"); card.className = "audit-card";
        const title = document.createElement("strong"); title.textContent = `${order.item} — ${order.buyerName}`;
        const meta = document.createElement("p"); meta.textContent = `${escortStatuses[order.status] || order.status} • ${order.participants.filter((item) => !item.replacedAt).map((item) => `${item.name} (${item.assignmentStatus})`).join(", ")}`;
        card.append(title, meta); container.append(card);
      });
    } catch (error) { container.replaceChildren(empty("Ошибка календаря", error.message)); }
  }

  async function loadAnalytics() {
    const container = document.querySelector("#operationsAnalytics");
    if (!container) return;
    container.replaceChildren(empty("Загрузка…", "Считаем показатели"));
    try {
      const { from, to } = reportDates();
      const [profiles, active, cancelled, report] = await Promise.all([
        api("/api/admin/player-profiles?page=1&pageSize=100", { method: "GET" }),
        api("/api/admin/escort-orders?page=1&pageSize=50", { method: "GET" }),
        api("/api/admin/escort-orders?status=cancelled&page=1&pageSize=50", { method: "GET" }),
        api(`/api/admin/reports/financial?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "GET" }),
      ]);
      const topPlayer = [...profiles.items].sort((a, b) => Number(b.earnedUah) - Number(a.earnedUah))[0];
      const itemCounts = [...active.items, ...cancelled.items].reduce((map, order) => map.set(order.item, (map.get(order.item) || 0) + 1), new Map());
      const popular = [...itemCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const values = [
        ["Оборот за период", money(report.grossUah)],
        ["Заказов за период", report.orderCount],
        ["Отменено", cancelled.total],
        ["Сопровождающих", profiles.total],
        ["Лучший игрок", topPlayer ? `${topPlayer.displayName} • ${money(topPlayer.earnedUah)}` : "Нет данных"],
        ["Популярная позиция", popular ? `${popular[0]} • ${popular[1]}` : "Нет данных"],
      ];
      container.replaceChildren();
      values.forEach(([label, value]) => { const card = document.createElement("article"); const small = document.createElement("small"); small.textContent = label; const strong = document.createElement("strong"); strong.textContent = value; card.append(small, strong); container.append(card); });
    } catch (error) { container.replaceChildren(empty("Ошибка аналитики", error.message)); }
  }

  async function loadAuditLogs() {
    const container = document.querySelector("#auditLogs");
    if (!container) return;
    container.replaceChildren(empty("Загрузка…", "Получаем журнал действий"));
    try {
      const result = await api("/api/admin/audit-logs?page=1&pageSize=100", { method: "GET" });
      container.replaceChildren();
      if (!result.items.length) container.append(empty("Журнал пуст", "Новые действия появятся здесь."));
      result.items.forEach((log) => {
        const item = document.createElement("article"); item.className = "audit-card";
        const title = document.createElement("strong"); title.textContent = log.action;
        const meta = document.createElement("p"); meta.textContent = `${log.adminUsername || "Система"} • ${log.entityType}${log.entityId ? ` ${log.entityId}` : ""} • ${new Date(log.createdAt).toLocaleString("ru-RU")}`;
        item.append(title, meta); container.append(item);
      });
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  async function loadAccounts() {
    const container = document.querySelector("#adminAccounts");
    if (!container || currentRole !== "owner") return;
    container.replaceChildren(empty("Загрузка…", "Получаем аккаунты"));
    try {
      const result = await api("/api/admin/accounts", { method: "GET" });
      container.replaceChildren();
      result.items.forEach((account) => {
        const card = document.createElement("article"); card.className = "account-card";
        const name = document.createElement("strong"); name.textContent = account.username;
        const role = document.createElement("select"); writeControl(role);
        [["owner", "Владелец"], ["director", "Директор"], ["admin", "Администратор"], ["observer", "Наблюдатель"]].forEach(([value, label]) => {
          const option = document.createElement("option"); option.value = value; option.textContent = label; option.selected = account.role === value; role.append(option);
        });
        const active = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = account.active; writeControl(checkbox); active.append(checkbox, document.createTextNode(" Активен"));
        const save = document.createElement("button"); save.type = "button"; save.textContent = "Сохранить"; writeControl(save);
        save.addEventListener("click", async () => { try { await api(`/api/admin/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify({ role: role.value, active: checkbox.checked }) }); await loadAccounts(); } catch (error) { globalStatus.textContent = error.message; } });
        const twoFactor = document.createElement("button"); twoFactor.type = "button"; twoFactor.textContent = account.twoFactorEnabled ? "Отключить 2FA" : "Настроить 2FA"; writeControl(twoFactor);
        twoFactor.addEventListener("click", async () => {
          try {
            if (account.twoFactorEnabled) {
              if (!window.confirm(`Отключить 2FA для ${account.username}?`)) return;
              await api(`/api/admin/accounts/${account.id}/2fa`, { method: "DELETE", body: "{}" });
            } else {
              const setup = await api(`/api/admin/accounts/${account.id}/2fa/setup`, { method: "POST", body: "{}" });
              window.prompt("Добавьте этот секрет в Google/Microsoft Authenticator", setup.secret);
              const code = window.prompt("Введите шестизначный код из приложения");
              if (!code) return;
              await api(`/api/admin/accounts/${account.id}/2fa/confirm`, { method: "POST", body: JSON.stringify({ code }) });
            }
            await loadAccounts();
          } catch (error) { globalStatus.textContent = error.message; }
        });
        card.append(name, role, active, save, twoFactor); container.append(card);
      });
    } catch (error) { container.replaceChildren(empty("Ошибка загрузки", error.message)); }
  }

  async function refreshDashboard() {
    const dashboard = await api("/api/admin/dashboard", { method: "GET" });
    csrfToken = dashboard.csrfToken;
    currentRole = dashboard.admin.role || "admin";
    document.querySelector("#accountsTab").hidden = currentRole !== "owner";
    storageSet("sessionStorage", "undying_admin_csrf", csrfToken);
    const changed = applyAccessMode(dashboard.accessMode === "observer" || dashboard.canWrite === false ? "observer" : "operator");
    renderCounts(dashboard.counts);
    return changed;
  }

  async function refreshAll() {
    globalStatus.textContent = "";
    await refreshDashboard();
      await Promise.all([loadReviews(), loadTickets(), loadEscortOrders(), loadCompletedEscorts(), loadArchivedEscorts(), loadPlayerProfiles(), loadPenalties(), loadAppeals(), loadFinancialReport(), loadAuditLogs(), currentRole === "owner" ? loadAccounts() : Promise.resolve()]);
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
    if (activeTab === "completed") {
      await loadCompletedEscorts();
      return;
    }
    if (activeTab === "archive") { await loadArchivedEscorts(); return; }
    if (activeTab === "players") { await loadPlayerProfiles(); return; }
    if (activeTab === "calendar") { await loadCalendar(); return; }
    if (activeTab === "penalties") { await loadPenalties(); return; }
    if (activeTab === "appeals") { await loadAppeals(); return; }
    if (activeTab === "payments") { await loadPayments(); return; }
    if (activeTab === "reports") { await loadFinancialReport(); return; }
    if (activeTab === "analytics") { await loadAnalytics(); return; }
    if (activeTab === "audit") { await loadAuditLogs(); return; }
    if (activeTab === "accounts") { await loadAccounts(); return; }
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
      return;
    }
    if (section === "completed") {
      activateTab("completed");
      await loadCompletedEscorts();
    }
  }

  document.querySelector("#refreshButton").addEventListener("click", () => void refreshAll());
  document.querySelector("#playerSearch").addEventListener("input", () => void loadPlayerProfiles());
  document.querySelector("#calendarFrom").addEventListener("change", () => void loadCalendar());
  document.querySelector("#calendarTo").addEventListener("change", () => void loadCalendar());
  document.querySelector("#penaltySearch").addEventListener("input", () => void loadPenalties());
  document.querySelector("#appealFilter").addEventListener("change", () => void loadAppeals());
  document.querySelector("#loadReport").addEventListener("click", () => void loadFinancialReport());
  document.querySelector("#downloadReport").addEventListener("click", () => void downloadFinancialReport());
  document.querySelector("#restoreBackup").addEventListener("click", () => document.querySelector("#restoreBackupFile").click());
  document.querySelector("#restoreBackupFile").addEventListener("change", (event) => { const [file] = event.target.files; if (file) void restoreBackup(file); event.target.value = ""; });
  document.querySelector("#downloadBackup").addEventListener("click", () => void downloadBackup());
  document.querySelector("#clearEscortOperations").addEventListener("click", () => void clearEscortOperations());
  document.querySelector("#accountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    busy(form, true);
    try {
      await api("/api/admin/accounts", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset();
      await loadAccounts();
    } catch (error) { globalStatus.textContent = error.message; }
    finally { busy(form, false); }
  });

  document.querySelector("#passkeyLoginButton").addEventListener("click", async () => {
    const username = loginForm.elements.username.value.trim().toLowerCase();
    if (!username) { document.querySelector("#loginStatus").textContent = "Сначала введите логин"; loginForm.elements.username.focus(); return; }
    if (!window.PublicKeyCredential) { document.querySelector("#loginStatus").textContent = "Этот браузер не поддерживает Passkey"; return; }
    try {
      const options = await api("/api/admin/passkeys/authentication-options", { method: "POST", body: JSON.stringify({ username }) });
      const credential = await navigator.credentials.get({ publicKey: authenticationOptions(options) });
      const result = await api("/api/admin/passkeys/authenticate", { method: "POST", body: JSON.stringify({ username, response: credentialJson(credential) }) });
      csrfToken = result.csrfToken; adminAuthToken = result.sessionToken || "";
      storageSet("sessionStorage", "undying_admin_csrf", csrfToken); if (adminAuthToken) storageSet("localStorage", "undying_admin_token", adminAuthToken);
      await bootstrap(true);
    } catch (error) { document.querySelector("#loginStatus").textContent = error.name === "NotAllowedError" ? "Вход Face ID отменён" : error.message; }
  });

  document.querySelector("#registerPasskeyButton").addEventListener("click", async () => {
    if (!window.PublicKeyCredential) { globalStatus.textContent = "Этот браузер не поддерживает Passkey"; return; }
    const button = document.querySelector("#registerPasskeyButton"); button.disabled = true;
    try {
      const options = await api("/api/admin/passkeys/registration-options", { method: "POST", body: "{}" });
      const credential = await navigator.credentials.create({ publicKey: registrationOptions(options) });
      await api("/api/admin/passkeys/register", { method: "POST", body: JSON.stringify({ response: credentialJson(credential) }) });
      globalStatus.textContent = "Face ID / Passkey добавлен. Теперь вход возможен без пароля.";
    } catch (error) { globalStatus.textContent = error.name === "NotAllowedError" ? "Добавление Face ID отменено" : error.message; }
    finally { button.disabled = false; }
  });
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
        clearSession();
        showLogin("Сессия истекла");
      }
    } finally {
      heartbeatRunning = false;
    }
  }, 20_000);
  void bootstrap().then(() => adminApp.hidden ? undefined : applyDeepLink());
})();
