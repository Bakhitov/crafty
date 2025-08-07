# Database Setup для n8n Credentials Tool

## Требования к базе данных

Для корректной работы `n8n-credentials-tool` в таблице `credentials` в базе данных Supabase должны быть следующие поля:

### Структура таблицы `credentials`

```sql
CREATE TABLE public.credentials (
  name text null,                    -- Внутреннее имя типа credential (например: "githubApi")
  "displayName" text null,           -- Отображаемое имя (например: "GitHub API")
  "documentationUrl" text null,      -- URL документации (опционально)
  properties jsonb null,             -- Конфигурация полей в формате JSON
  test jsonb null,                   -- Тестовые конфигурации
  "iconUrl" text null,               -- URL иконки
  authenticate jsonb null,           -- Настройки аутентификации
  "supportedNodes" jsonb null,       -- Поддерживаемые ноды
  extends text null,                 -- Расширяет другой тип credential
  "httpRequestNode" text null,       -- HTTP Request настройки
  icon text null,                    -- Иконка
  "iconColor" text null              -- Цвет иконки
) TABLESPACE pg_default;
```

### Поля для поиска

Tool выполняет поиск по следующим полям:
- `name` - внутреннее имя типа credential
- `displayName` - отображаемое имя
- `documentationUrl` - URL документации

### Формат поля `properties`

Поле `properties` должно содержать JSON объект с описанием требуемых полей для каждого типа credential:

```json
{
  "accessToken": {
    "type": "string",
    "required": true,
    "displayName": "Access Token",
    "description": "GitHub personal access token"
  },
  "server": {
    "type": "string", 
    "required": false,
    "default": "https://api.github.com",
    "displayName": "Server"
  }
}
```

### Примеры записей

#### GitHub API
```sql
INSERT INTO credentials (name, "displayName", "documentationUrl", properties) VALUES (
  'githubApi',
  'GitHub API', 
  'https://docs.github.com/en/rest',
  '{
    "accessToken": {
      "type": "string",
      "required": true,
      "displayName": "Access Token",
      "description": "GitHub personal access token"
    }
  }'::jsonb
);
```

#### Telegram Bot API
```sql
INSERT INTO credentials (name, "displayName", "documentationUrl", properties) VALUES (
  'telegramApi',
  'Telegram Bot API',
  'https://core.telegram.org/bots/api',
  '{
    "accessToken": {
      "type": "string", 
      "required": true,
      "displayName": "Access Token",
      "description": "Telegram bot token from @BotFather"
    }
  }'::jsonb
);
```

#### Slack API
```sql
INSERT INTO credentials (name, "displayName", "documentationUrl", properties) VALUES (
  'slackApi',
  'Slack API',
  'https://api.slack.com/',
  '{
    "token": {
      "type": "string",
      "required": true, 
      "displayName": "Token",
      "description": "Slack Bot User OAuth Token"
    }
  }'::jsonb
);
```

## Создание индексов для оптимизации поиска

Для улучшения производительности поиска рекомендуется создать следующие индексы:

```sql
-- Индекс для поиска по name
CREATE INDEX IF NOT EXISTS idx_credentials_name ON credentials USING gin(to_tsvector('english', name));

-- Индекс для поиска по displayName  
CREATE INDEX IF NOT EXISTS idx_credentials_display_name ON credentials USING gin(to_tsvector('english', "displayName"));

-- Индекс для поиска по documentationUrl
CREATE INDEX IF NOT EXISTS idx_credentials_documentation_url ON credentials USING gin(to_tsvector('english', "documentationUrl"));

-- Простые индексы для LIKE запросов
CREATE INDEX IF NOT EXISTS idx_credentials_name_like ON credentials (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_credentials_display_name_like ON credentials (LOWER("displayName"));
```

## Подключение к базе данных

Tool использует переменную окружения `DATABASE_URL` для подключения к PostgreSQL через библиотеку `pg`:

```typescript
const connectionString = process.env.DATABASE_URL || 'postgresql://user:pass@host:5432/dbname';
```

Установите переменную окружения:
```bash
export DATABASE_URL="postgresql://postgres:Ginifi51!@db.wyehpfzafbjfvyjzgjss.supabase.co:5432/postgres"
```

Или создайте файл `.env`:
```
DATABASE_URL=postgresql://postgres:Ginifi51!@db.wyehpfzafbjfvyjzgjss.supabase.co:5432/postgres
```

## Как работает поиск

1. Tool выполняет LIKE запрос по полям `name`, `displayName`, и `documentationUrl`
2. Возвращает до 10 результатов
3. Если найдено несколько типов - показывает список для выбора
4. Если найден один тип - извлекает требуемые поля из `properties`
5. Запрашивает у пользователя необходимые данные
6. Создает credentials в n8n через API

## Безопасность

⚠️ **Важно**: В production окружении:
- Используйте переменные окружения для строки подключения к БД
- Используйте SSL соединения
- Ограничьте права доступа к таблице только для чтения
- Валидируйте входные данные от пользователей
- Никогда не логируйте токены и пароли пользователей
- Используйте защищенные соединения для API запросов к n8n

## Тестирование

Для тестирования tool без реальной БД, используйте mock данные или тестовую базу данных.

```typescript
// Пример тестирования schema
const result = n8nCredentialsTool.inputSchema.safeParse({
  search_term: 'github',
  credential_name: 'Test Credentials'
});
console.log('Valid input:', result.success);
```