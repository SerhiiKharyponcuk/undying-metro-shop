# Развёртывание Undying Metro Shop

## 1. Cloudflare Turnstile

1. В панели Cloudflare откройте **Turnstile → Add widget**.
2. Добавьте домены `serhiikharyponcuk.github.io` и `localhost` для локальной проверки.
3. Скопируйте публичный **Site key** в `config.js` как `TURNSTILE_SITE_KEY`.
4. Сохраните секретный **Secret key** только в Render как `TURNSTILE_SECRET_KEY`.
5. В production оставьте `TURNSTILE_REQUIRED=true`.

Site key можно публиковать. Secret key нельзя добавлять в GitHub или `config.js`.

## 2. Telegram-бот и Chat ID

1. Откройте официального бота `@BotFather`, выполните `/newbot` и сохраните полученный токен.
2. Напишите новому боту любое сообщение. Для группового чата добавьте бота в группу и отправьте сообщение в группу.
3. Временно откройте `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `message.chat.id`. У групп ID обычно начинается с минуса.
4. Сохраните токен в Render как `TELEGRAM_BOT_TOKEN`.
5. Сохраните один или несколько ID через запятую в `TELEGRAM_ADMIN_CHAT_IDS`, например `123456789,-1001234567890`.
6. После проверки не пересылайте токен и при утечке отзовите его через `@BotFather`.

Ошибки Telegram записываются в серверный лог и таблицу `notification_logs`, но не отменяют сохранение отзыва или заявки.

## 3. Backend и PostgreSQL на Render

1. Подключите этот GitHub-репозиторий к Render.
2. Выберите **New → Blueprint**: Render прочитает `render.yaml` и предложит создать web service и PostgreSQL.
3. Заполните секретные переменные `TURNSTILE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN` и `TELEGRAM_ADMIN_CHAT_IDS`.
4. Проверьте `CORS_ORIGINS`. Там должны быть точные origin-адреса без пути и завершающего слеша, например `https://serhiikharyponcuk.github.io`.
5. После запуска откройте `https://<ваш-backend>.onrender.com/api/health`.

Команда запуска автоматически выполняет безопасные production-миграции `prisma migrate deploy`, затем запускает собранный сервер.

Панель получает курсы EUR и USD из официального API НБУ по выбранной дате. Полученный курс сохраняется вместе с расчётом и позже не меняется. Если API НБУ временно недоступен, администратор может ввести курс к гривне вручную; источник курса также сохраняется в базе. Для каждого нового заказа обязателен PUBG ID покупателя. При создании заказа администратор получает одноразовый код отзыва и передаёт его покупателю. Отзыв принимается только по сочетанию PUBG ID, кода и статуса «завершено» либо «выплачено».

Миграции также создают журнал штрафов, связи замены и отметку автоматического исключения сопровождающих. Баланс «Банка Metro Shop» вычисляется из записей штрафов, «Банк директора» — из 3%, а отдельный «Банк создателя» — из 10% каждого неотменённого сопровождения. Все три баланса не требуют переменных окружения или ручного начального значения.

## 4. Первый администратор без Shell

Пароль по умолчанию отсутствует. В Render → **Environment** временно добавьте `ADMIN_INITIAL_USERNAME` и `ADMIN_INITIAL_PASSWORD` (не короче 12 символов) и сохраните изменения. При следующем запуске сервер автоматически создаст первого администратора с ролью владельца, только если таблица `admins` ещё пуста.

После успешного входа удалите `ADMIN_INITIAL_PASSWORD` и `ADMIN_INITIAL_USERNAME` из окружения. Повторные перезапуски не создают дополнительных пользователей и не меняют существующий пароль. Пароль сохраняется только в виде Argon2id-хеша. Для ручного создания дополнительного администратора по-прежнему доступна команда `npm run admin:create`.

Несколько администраторов могут держать панель открытой одновременно. Первая активная сессия управляет данными, остальные автоматически получают режим наблюдения. При выходе или потере heartbeat управляющей сессии один из активных наблюдателей становится управляющим без повторного входа.

## 5. Frontend на GitHub Pages

Админ-панель рекомендуется открывать непосредственно с backend Render:

`https://undying-metro-api.onrender.com/admin/`

Этот адрес публичный и работает по HTTPS с iPhone, Android, компьютера и из любой сети. Панель и API находятся на одном домене, поэтому вход использует first-party cookie и не зависит от ограничений Safari на сторонние cookie. Устанавливать VPN или находиться в одной Wi-Fi-сети с сервером не нужно. Не публикуйте пароль администратора и создавайте отдельный аккаунт для каждого сотрудника.

Версия `/admin/` на GitHub Pages остаётся запасной, но для мобильных устройств используйте адрес Render выше.

1. В `config.js` укажите публичный URL Render без завершающего слеша:

```js
window.UNDYING_CONFIG = Object.freeze({
  API_BASE_URL: "https://undying-metro-api.onrender.com",
  TURNSTILE_SITE_KEY: "ваш-публичный-site-key",
  MANAGERS: [
    { key: "manager_1", name: "Имя", specialty: "Покупки", telegramUrl: "https://t.me/username_one", avatar: "assets/manager-01.webp" },
    { key: "manager_2", name: "Имя", specialty: "Оплата", telegramUrl: "https://t.me/username_two", avatar: "assets/manager-02.webp" },
  ],
});
```

Не меняйте ключи `manager_1` и `manager_2`: по ним backend синхронизирует трёхминутную занятость. Имена, описания, Telegram-ссылки и аватарки можно менять свободно.

2. В GitHub откройте **Settings → Pages** и выберите публикацию ветки `main` из `/ (root)`.
3. Пользовательский сайт будет доступен по адресу `https://serhiikharyponcuk.github.io/undying-metro-shop/`; основной вход в админ-панель — `https://undying-metro-api.onrender.com/admin/`.
4. Убедитесь, что адрес GitHub Pages добавлен в разрешённые домены виджета Turnstile.

## 6. Локальная разработка

```bash
cp .env.example .env
npm ci
npm run prisma:dev
npm run admin:create
npm run dev
```

Статические файлы можно открыть локальным HTTP-сервером на origin, указанном в `CORS_ORIGINS`. Для локальной разработки разрешено `TURNSTILE_REQUIRED=false`.

## 7. Резервные копии PostgreSQL

Перед миграциями или значимыми изменениями создавайте дамп:

```bash
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" --file undying-metro-$(date +%F).dump
```

Проверяйте восстановление на отдельной тестовой базе:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$RESTORE_DATABASE_URL" undying-metro-YYYY-MM-DD.dump
```

Храните дампы в закрытом зашифрованном хранилище, задайте срок хранения и периодически проверяйте восстановление. Если тариф Render поддерживает управляемые резервные копии, включите их дополнительно; логический дамп всё равно полезен перед миграциями.

В репозитории также есть workflow `.github/workflows/database-backup.yml`. Для него добавьте в **Settings → Secrets and variables → Actions**:

- `DATABASE_URL` — production-строка подключения PostgreSQL;
- `BACKUP_ENCRYPTION_KEY` — длинный отдельный ключ шифрования.

Workflow ежедневно создаёт зашифрованный AES-256 архив и хранит его как приватный GitHub Actions artifact 7 дней. Ключ шифрования нельзя хранить в репозитории или передавать вместе с архивом.

## 8. CI и проверка production

Workflow `ci.yml` на каждой ветке и PR запускает typecheck, тесты, сборку, Prisma validate и синтаксическую проверку браузерного JavaScript.

Для `deployment-health.yml` добавьте секрет `PRODUCTION_HEALTH_URL` со значением полного адреса, например `https://undying-metro-api.onrender.com/api/health`. После будущего push в `main` workflow ждёт Render и до десяти раз проверяет health endpoint. Это не заменяет мониторинг Render, но сразу показывает неуспешный деплой в GitHub Actions.
