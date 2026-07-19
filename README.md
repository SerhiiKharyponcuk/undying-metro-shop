# Undying Metro Shop

Полноценный русскоязычный сайт Metro-магазина: сохранён исходный дизайн, фирменная аватарка, загрузка, движущийся фон, мобильная адаптация и анимации переходов. К статическому frontend добавлены отзывы, поддержка с перепиской, выбор менеджера с общей серверной занятостью и защищённая административная панель.

## Архитектура

- **Frontend:** существующие HTML, CSS и JavaScript, размещение на GitHub Pages.
- **Backend:** Node.js 22, TypeScript и Fastify.
- **Данные:** PostgreSQL и Prisma ORM.
- **Защита:** Argon2id, серверные сессии с подписанной HttpOnly-cookie, CSRF, CORS allowlist, Helmet, rate limit, Turnstile, строгая Zod-валидация.
- **Уведомления:** Telegram Bot API для нескольких администраторов.
- **Хостинг API:** Render Blueprint из `render.yaml`.

## Возможности

Посетитель может отправить отзыв со звёздной оценкой. Отзыв получает статус `pending` и появляется публично только после публикации администратором. Доступна подгрузка следующих отзывов и официальный ответ магазина.

Поддержка создаёт заявку с уникальным публичным номером и случайным секретным ключом. Ключ хранится на сервере только как Argon2id-хеш. Пользователь может вернуться к заявке в том же браузере или открыть её по номеру и ключу, читать историю и отвечать менеджеру.

В окне «Менеджеры» показываются два оператора с живым статусом. При переходе в Telegram выбранный менеджер атомарно помечается занятым в PostgreSQL на 3 минуты, поэтому другой посетитель не сможет одновременно выбрать его. Статусы обновляются автоматически.

Отдельная панель `/admin/` позволяет модерировать отзывы, отвечать от имени магазина, искать и фильтровать заявки, менять их статусы и вести переписку. В разделе «Сопроводы» администратор записывает покупку, покупателя и от одного до трёх сопровождающих. Оплата в UAH, EUR или USD пересчитывается в гривны по курсу НБУ на дату заказа либо по введённому вручную курсу. Система фиксирует курс, выделяет 10% разработчику, точно распределяет остальные 90% между сопровождающими и хранит отметки о выплатах.

Для каждого сопровождающего действует персональная последовательность штрафов: 5%, 10%, 15% и 50% от его исходной доли. Каждый штраф требует причины и остаётся в истории, а удержанная сумма автоматически увеличивает баланс «Банка Metro Shop». При замене прежний игрок сохраняется в аудите, штрафы остаются в банке, а новому игроку переходит только невыплаченный остаток доли. Новый игрок начинает собственную шкалу с 5%. Для удобного входа также доступен короткий адрес `/admin.html`. Публичного или стандартного пароля нет.

## Быстрый запуск

Требуются Node.js 22 и PostgreSQL.

```bash
cp .env.example .env
npm ci
npm run prisma:dev
npm run admin:create
npm run dev
```

Для первого запуска временно заполните переменные `ADMIN_INITIAL_USERNAME` и `ADMIN_INITIAL_PASSWORD`. Если таблица администраторов ещё пуста, сервер автоматически создаст первого администратора при старте — Shell не требуется. После успешного входа удалите обе переменные из окружения. Команда `admin:create` остаётся доступной как ручной вариант.

Frontend обращается к API через единственную настройку в `config.js`:

```js
window.UNDYING_CONFIG = Object.freeze({
  API_BASE_URL: "https://ваш-api.onrender.com",
  TURNSTILE_SITE_KEY: "публичный-site-key",
  MANAGERS: [
    {
      key: "manager_1",
      name: "Имя первого менеджера",
      specialty: "Покупки и наличие",
      telegramUrl: "https://t.me/username_one",
      avatar: "assets/manager-01.webp",
    },
    {
      key: "manager_2",
      name: "Имя второго менеджера",
      specialty: "Оплата и заказы",
      telegramUrl: "https://t.me/username_two",
      avatar: "assets/manager-02.webp",
    },
  ],
});
```

## Переменные окружения

Все поддерживаемые значения перечислены в `.env.example`:

- `DATABASE_URL` — строка подключения PostgreSQL;
- `CORS_ORIGINS` — точные разрешённые origin через запятую;
- `COOKIE_SECRET`, `TICKET_TOKEN_PEPPER`, `IP_HASH_SALT` — три независимых случайных секрета длиной от 32 символов;
- `SESSION_TTL_HOURS` — срок жизни административной сессии;
- `TURNSTILE_REQUIRED`, `TURNSTILE_SECRET_KEY` — защита публичных форм;
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_IDS` — бот и список Chat ID;
- `ADMIN_PANEL_URL` — публичный адрес панели для ссылок в Telegram.

В production Turnstile обязателен. Настоящие пароли, токены и ключи не должны попадать в GitHub.

## API

Публичные маршруты:

- `GET /api/health`
- `GET /api/managers`
- `POST /api/managers/:key/claim`
- `GET /api/reviews`
- `POST /api/reviews`
- `POST /api/support/tickets`
- `GET /api/support/tickets/:number`
- `POST /api/support/tickets/:number/messages`

Для чтения и ответа в заявке клиент передаёт секретный ключ в заголовке `x-ticket-token`. API никогда не возвращает хеш токена, IP-хеш, пароли или сессионные токены.

Административные маршруты:

- `POST /api/admin/login`, `POST /api/admin/logout`
- `GET /api/admin/dashboard`
- `GET /api/admin/reviews`, `PATCH /api/admin/reviews/:id`
- `GET /api/admin/tickets`, `GET /api/admin/tickets/:id`
- `POST /api/admin/tickets/:id/messages`
- `PATCH /api/admin/tickets/:id/status`
- `GET /api/admin/exchange-rate`
- `GET`, `POST /api/admin/escort-orders`
- `PATCH /api/admin/escort-orders/:id/status`
- `PATCH /api/admin/escort-orders/:id/participants/:participantId`
- `POST /api/admin/escort-orders/:id/participants/:participantId/penalties`
- `POST /api/admin/escort-orders/:id/participants/:participantId/replacement`
- `GET /api/admin/shop-bank`

Изменяющие административные запросы требуют действующую HttpOnly-сессию и `x-csrf-token`.

## Команды

```bash
npm run dev             # API с автоматическим перезапуском
npm run typecheck       # проверка TypeScript
npm test                # тесты API и безопасности
npm run build           # production-сборка в dist/
npm run prisma:migrate  # применение production-миграций
npm run admin:create    # безопасное создание первого администратора
npm start               # запуск собранного API
```

Тесты покрывают создание и модерацию отзывов, заявки и переписку, вход и права администратора, CSRF, rate limit, XSS, неверные данные, недействительный ключ заявки, точный расчёт сопровождений, ступени штрафов, банк магазина и замену игроков.

Подробная инструкция по Render, GitHub Pages, Telegram, Cloudflare Turnstile и резервному копированию находится в [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
