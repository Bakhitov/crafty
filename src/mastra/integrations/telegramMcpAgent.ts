import TelegramBot from "node-telegram-bot-api";
import { RuntimeContext } from "@mastra/core/di";
import { mcpAgent } from "../agents/mcpAgent";
import { UserRuntimeContext, mcpPool, getMcpClientForRuntime } from "../mcp";
import { UserValidationService } from "../services/userValidationService";
import { UserRegistrationService } from "../services/userRegistrationService";

interface ToolUsage {
  toolName: string;
  args: any;
  result: any;
  timestamp: Date;
  chatId: number;
  userId: string;
}

export class TelegramIntegration {
  private bot: TelegramBot;
  private readonly MAX_MESSAGE_LENGTH = 4096; // Telegram's message length limit
  private readonly MAX_RESULT_LENGTH = 500; // Maximum length for tool results
  private toolHistory: ToolUsage[] = []; // Store tool usage history
  private readonly MAX_HISTORY_SIZE = 50; // Keep last 50 tool usages
  private chatThreadId = new Map<number, string>(); // keep latest threadId per chat

  // Centralized catalog of LLM providers and models
  private readonly llmCatalog: Array<{ name: string; key: string; models: string[] }> = [
    {
      name: 'xAI Grok',
      key: 'xai',
      models: ['grok-3', 'grok-3-fast', 'grok-3-mini', 'grok-3-mini-fast', 'grok-2-1212', 'grok-2-vision-1212', 'grok-beta', 'grok-vision-beta'],
    },
    {
      name: 'OpenAI',
      key: 'openai',
      models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'o3-mini', 'o3', 'o4-mini', 'o1', 'o1-mini', 'o1-preview'],
    },
    {
      name: 'Anthropic',
      key: 'anthropic',
      models: ['claude-4-opus-20250514', 'claude-4-sonnet-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620', 'claude-3-5-haiku-20241022'],
    },
    {
      name: 'Mistral',
      key: 'mistral',
      models: ['pixtral-large-latest', 'mistral-large-latest', 'mistral-small-latest', 'pixtral-12b-2409'],
    },
    {
      name: 'Google Generative AI',
      key: 'google',
      models: ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    },
    {
      name: 'Google Vertex',
      key: 'google-vertex',
      models: ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    },
    {
      name: 'DeepSeek',
      key: 'deepseek',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
      name: 'Cerebras',
      key: 'cerebras',
      models: ['llama3.1-8b', 'llama3.1-70b', 'llama3.3-70b'],
    },
    {
      name: 'Groq',
      key: 'groq',
      models: ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    },
  ];

  constructor(token: string) {
    // Create a bot instance
    this.bot = new TelegramBot(token, { polling: true });

    // Handle incoming messages
    this.bot.on("message", this.handleMessage.bind(this));
  }

  async cleanup(): Promise<void> {
    try {
      // node-telegram-bot-api stops naturally on process exit; here we focus on MCP pooling
      await mcpPool.disconnectAll();
    } catch (e) {
      console.warn('⚠️ Telegram cleanup warning:', e);
    }
  }

  private escapeMarkdown(text: string): string {
    // Escape special Markdown characters
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
  }

  private truncateString(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + "... [truncated]";
  }

  private formatToolResult(result: any): string {
    try {
      const jsonString = JSON.stringify(result, null, 2);
      return this.escapeMarkdown(
        this.truncateString(jsonString, this.MAX_RESULT_LENGTH)
      );
    } catch (error) {
      return `[Complex data structure - ${typeof result}]`;
    }
  }

  private addToToolHistory(toolUsage: ToolUsage): void {
    this.toolHistory.push(toolUsage);
    // Keep only the last MAX_HISTORY_SIZE entries
    if (this.toolHistory.length > this.MAX_HISTORY_SIZE) {
      this.toolHistory = this.toolHistory.slice(-this.MAX_HISTORY_SIZE);
    }
  }

  private formatToolHistory(chatId: number, limit: number = 10): string {
    const userTools = this.toolHistory
      .filter(tool => tool.chatId === chatId)
      .slice(-limit) // Get last N tools
      .reverse(); // Show newest first

    if (userTools.length === 0) {
      return "🔧 *История инструментов пуста*\n\nВы еще не использовали никаких инструментов\\.";
    }

    let message = `🔧 *Последние инструменты \\(${userTools.length}\\)*\n\n`;
    
    userTools.forEach((tool, index) => {
      const timeStr = tool.timestamp.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      message += `${index + 1}\\. *${this.escapeMarkdown(tool.toolName)}*\n`;
      message += `   ⏰ ${this.escapeMarkdown(timeStr)}\n`;
      
      // Show args
      try {
        const argsStr = typeof tool.args === 'string' 
          ? tool.args 
          : JSON.stringify(tool.args, null, 2);
        message += `   📝 Аргументы: \`${this.escapeMarkdown(argsStr)}\`\n`;
      } catch {
        message += `   📝 \\[Сложные параметры\\]\n`;
      }
      
      // Show result
      try {
        const resultStr = this.formatToolResult(tool.result);
        message += `   ✨ Результат: \`${resultStr}\`\n`;
      } catch {
        message += `   ✨ \\[Сложный результат\\]\n`;
      }
      
      message += `\n`;
    });

    return message;
  }

  private async handleLogsCommand(chatId: number): Promise<void> {
    try {
      const userTools = this.toolHistory
        .filter(tool => tool.chatId === chatId)
        .slice(-10) // Last 10 tools
        .reverse(); // Newest first

      if (userTools.length === 0) {
        await this.bot.sendMessage(chatId, "Нет логов использования инструментов\\.");
        return;
      }

      // Create JSON data
      const jsonData = {
        export_date: new Date().toISOString(),
        chat_id: chatId,
        tools_count: userTools.length,
        tools: userTools.map(tool => ({
          tool_name: tool.toolName,
          timestamp: tool.timestamp.toISOString(),
          arguments: tool.args,
          result: tool.result,
          user_id: tool.userId
        }))
      };

      // Convert to JSON string
      const jsonString = JSON.stringify(jsonData, null, 2);
      const buffer = Buffer.from(jsonString, 'utf-8');

      // Generate filename with timestamp
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `logs_${chatId}_${timestamp}.json`;

      // Send file
      await this.bot.sendDocument(chatId, buffer, {
        caption: `📄 Логи инструментов (${userTools.length} записей)`
      }, {
        filename: filename,
        contentType: 'application/json'
      });

    } catch (error) {
      console.error("Error sending logs file:", error);
      await this.bot.sendMessage(chatId, "Ошибка создания файла с логами инструментов\\.");
    }
  }

  private async updateOrSplitMessage(
    chatId: number,
    messageId: number | undefined,
    text: string
  ): Promise<number> {
    // If text is within limits, try to update existing message
    if (text.length <= this.MAX_MESSAGE_LENGTH && messageId) {
      try {
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "MarkdownV2",
        });
        return messageId;
      } catch (error) {
        console.error("Error updating message:", error);
      }
    }

    // If text is too long or update failed, send as new message
    try {
      const newMessage = await this.bot.sendMessage(chatId, text, {
        parse_mode: "MarkdownV2",
      });
      return newMessage.message_id;
    } catch (error) {
      console.error("Error sending message:", error);
      // If the message is still too long, truncate it
      const truncated =
        text.substring(0, this.MAX_MESSAGE_LENGTH - 100) +
        "\n\n... [Message truncated due to length]";
      const fallbackMsg = await this.bot.sendMessage(chatId, truncated, {
        parse_mode: "MarkdownV2",
      });
      return fallbackMsg.message_id;
    }
  }

  private async handleMessage(msg: TelegramBot.Message) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const username = msg.from?.username || "unknown";
    const firstName = msg.from?.first_name || "unknown";
    const lastName = msg.from?.last_name || "";
    const userId = msg.from?.id.toString() || `anonymous-${chatId}`;

    if (!text) {
      const raw = "Sorry, I can only process text messages.";
      await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: "MarkdownV2" });
      return;
    }

    // Handle /start: greet or suggest /pay and create stub user
    if (text === "/start") {
      const fullName = `${firstName}${lastName ? " " + lastName : ""}`.trim();
      const displayName = username ? `@${username}` : (fullName || `user_${chatId}`);
      const existing = await UserRegistrationService.findByContactId(chatId.toString());
      if (existing?.contact_id) {
        const raw = `👋 Привет, ${this.escapeMarkdown(displayName)}! Ваш аккаунт найден.\nМожете продолжать работу с ботом.`;
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: "MarkdownV2" });
      } else {
        // Create inactive user stub
        await UserRegistrationService.createInactiveUser({
          contactId: chatId.toString(),
          name: displayName,
        });
        const raw = `👋 Привет, ${this.escapeMarkdown(displayName)}!\nВаш аккаунт еще не активирован. Для активации выполните оплату командой /pay.`;
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: "MarkdownV2" });
      }
      return;
    }

    // Handle /pay placeholder (stub)
    if (text === "/pay") {
      const raw = "💳 Оплата пока недоступна внутри Telegram. Свяжитесь с администратором, после оплаты ваш аккаунт будет активирован.";
      await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: "MarkdownV2" });
      return;
    }

    // Handle /addmodel - allow: /addmodel <provider> <model> OR /addmodel <model> (auto-detect provider)
    if (text?.startsWith('/addmodel')) {
      const rawArgs = text.replace('/addmodel', '').trim();
      if (!rawArgs) {
        await this.bot.sendMessage(
          chatId,
          this.escapeMarkdown('ℹ️ Укажите модель так: /addmodel <model>\nНапример: /addmodel gpt-4o\nСписок доступных моделей: /llm'),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      const parts = rawArgs.split(/\s+/);
      let providerKey: string | null = null;
      let modelName: string | null = null;

      if (parts.length >= 2) {
        const candidateProvider = parts[0].toLowerCase();
        const match = this.llmCatalog.find(p => p.key.toLowerCase() === candidateProvider || p.name.toLowerCase() === candidateProvider);
        if (match) {
          providerKey = match.key;
          modelName = parts.slice(1).join(' ');
        }
      }

      // If provider not provided or not recognized, treat entire args as model and detect provider
      if (!providerKey) {
        modelName = rawArgs;
        const lowerModel = modelName.toLowerCase();
        const found = this.llmCatalog.find(p => p.models.some(m => m.toLowerCase() === lowerModel));
        if (found) {
          providerKey = found.key;
        }
      }

      if (!providerKey || !modelName) {
        await this.bot.sendMessage(
          chatId,
          this.escapeMarkdown('❌ Не удалось определить провайдера/модель. Посмотрите доступные варианты: /llm'),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      // Validate that model exists for provider
      const providerEntry = this.llmCatalog.find(p => p.key === providerKey);
      if (!providerEntry || !providerEntry.models.map(m => m.toLowerCase()).includes(modelName.toLowerCase())) {
        await this.bot.sendMessage(
          chatId,
          this.escapeMarkdown(`❌ Модель "${modelName}" не найдена у провайдера "${providerKey}". Посмотрите список: /llm`),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      try {
        await UserRegistrationService.updateLlmModel({
          contactId: chatId.toString(),
          provider: providerKey,
          model: modelName,
        });
        // Refresh cache so new model is visible to validation immediately
        try { await UserValidationService.forceRefreshCache(); } catch {}
        const raw = `✅ Модель обновлена:\nprovider: ${providerKey}\nmodel: ${modelName}`;
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
      } catch (e) {
        console.error('addmodel error', e);
        await this.bot.sendMessage(chatId, '❌ Не удалось обновить модель');
      }
      return;
    }

    // Handle /addapikey KEY
    if (text?.startsWith('/addapikey')) {
      const key = text.replace('/addapikey', '').trim();
      if (!key) {
        await this.bot.sendMessage(chatId, 'ℹ️ Использование: /addapikey <API_KEY>');
        return;
      }
      try {
        await UserRegistrationService.updateLlmApiKey({
          contactId: chatId.toString(),
          apiKey: key,
        });
        // Refresh cache so new key is visible to validation immediately
        try { await UserValidationService.forceRefreshCache(); } catch {}
        await this.bot.sendMessage(chatId, '✅ Ключ LLM обновлён');
      } catch (e) {
        console.error('addapikey error', e);
        await this.bot.sendMessage(chatId, '❌ Не удалось обновить ключ');
      }
      return;
    }

    // Handle /llms and /llm - list providers/models in simple readable format
    if (text === '/llms' || text === '/llm') {
      const entries = this.llmCatalog.map(p => {
        const name = this.escapeMarkdown(p.name);
        const models = this.escapeMarkdown(p.models.join(', '));
        return `LLM: ${name}\nModels: ${models}`;
      });
      const message = entries.join('\n\n');
      await this.bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
      return;
    }

    // Handle /info - show agent capabilities and detailed interaction rules
    if (text === '/info') {
      // Part 1: Capabilities
      const cap: string[] = [];
      cap.push(this.escapeMarkdown('🤖 Возможности агента'));
      cap.push(this.escapeMarkdown('- Проектирует и собирает n8n-воркфлоу под конкретную задачу'));
      cap.push(this.escapeMarkdown('- Находит подходящие ноды: поиск по функции, категориям, AI-инструментам'));
      cap.push(this.escapeMarkdown('- Управляет credentials: обнаружение требуемых полей → запрос у вас → создание'));
      cap.push(this.escapeMarkdown('- Предварительная проверка конфигураций нод (минимальная/операционная)'));
      cap.push(this.escapeMarkdown('- Валидация всего воркфлоу: структура, связи, выражения'));
      cap.push(this.escapeMarkdown('- Деплой в n8n, активация, последующие изменения через дифф-обновления'));
      cap.push(this.escapeMarkdown('- Тестирование: вебхуки, проверки после деплоя, мониторинг исполнений'));
      cap.push(this.escapeMarkdown('- История инструментов и экспорт логов командой /logs'));
      await this.bot.sendMessage(chatId, cap.join('\n'), { parse_mode: 'MarkdownV2' });

      // Part 2: How to interact
      const how: string[] = [];
      how.push(this.escapeMarkdown('📝 Как общаться, чтобы всё получилось'));
      how.push(this.escapeMarkdown('1) Сформулируйте цель: что должно происходить и когда (триггеры/условия).'));
      how.push(this.escapeMarkdown('2) Перечислите сервисы: CRM/почта/Slack/Google Sheets/...'));
      how.push(this.escapeMarkdown('3) Готовьте доступы: агент сначала подскажет точные поля credentials, затем вы передадите значения.'));
      how.push(this.escapeMarkdown('4) Дайте конкретику: URL вебхука, события (например, contact.created), ID каналов/таблиц, форматы полей.'));
      how.push(this.escapeMarkdown('5) Подтвердите архитектуру: агент покажет схему → провалидирует → задеплоит → активирует.'));
      how.push(this.escapeMarkdown('6) По возможности избегайте код-ноды: используйте стандартные ноды (надёжнее и прозрачно).'));
      how.push(this.escapeMarkdown('7) Итерируйте по частям: небольшие изменения удобнее валидировать и деплоить.'));
      await this.bot.sendMessage(chatId, how.join('\n'), { parse_mode: 'MarkdownV2' });

      // Part 3: Examples
      const ex: string[] = [];
      ex.push(this.escapeMarkdown('📌 Примеры запросов'));
      ex.push(this.escapeMarkdown('- "При новом лидe в HubSpot отправлять письмо через Gmail и писать в Slack. Событие: contact.created. Поля: email, firstname. В Slack: канал #sales, текст: Новый лид: {firstname} <{email}>. В Gmail: шаблон Welcome."'));
      ex.push(this.escapeMarkdown('- "Подключи вебхук: POST JSON на https://example.com/webhook. Схема: {id, email, items[].sku}. При ошибках: логировать и ретраить до 3 раз с задержкой."'));
      ex.push(this.escapeMarkdown('- "Синхронизировать новые строки из Google Sheets в Notion. Поля: name, email, company. Дубликаты — обновлять по email."'));
      await this.bot.sendMessage(chatId, ex.join('\n'), { parse_mode: 'MarkdownV2' });

      // Part 4: Commands and setup
      const cmds: string[] = [];
      cmds.push(this.escapeMarkdown('🧰 Полезные команды'));
      cmds.push(this.escapeMarkdown('/start — создать профиль'));
      cmds.push(this.escapeMarkdown('/pay — оплата (позже)'));
      cmds.push(this.escapeMarkdown('/llm или /llms — список LLM и моделей'));
      cmds.push(this.escapeMarkdown('/addmodel <model> — выбрать модель (провайдер определяется по модели)'));
      cmds.push(this.escapeMarkdown('/addapikey <API_KEY> — добавить ключ LLM'));
      cmds.push(this.escapeMarkdown('/new — начать новый диалог; /reset — очистить тред'));
      cmds.push(this.escapeMarkdown('/logs — выгрузка логов инструментов'));
      cmds.push(this.escapeMarkdown('Важно: чтобы агент работал с LLM, задайте модель (/llm → /addmodel <model>) и ключ (/addapikey <key>).'));
      await this.bot.sendMessage(chatId, cmds.join('\n'), { parse_mode: 'MarkdownV2' });
      return;
    }

    // Handle /logs command
    if (text === "/logs") {
      await this.handleLogsCommand(chatId);
      return;
    }

    // Handle /reset command: delete last thread and clear mapping (and DB pointer)
    if (text === "/reset") {
      const lastThreadId = this.chatThreadId.get(chatId);
      try {
        const memory = mcpAgent.getMemory();
        if (memory && lastThreadId) {
          // Best-effort delete of the thread if supported by memory implementation
          const maybeDelete = (memory as unknown as { deleteThread?: (args: { resourceId: string; threadId: string }) => Promise<void> }).deleteThread;
          if (typeof maybeDelete === 'function') {
            await maybeDelete({
              resourceId: 'mcpAgent',
              threadId: lastThreadId,
            });
          }
        }
      } catch (e) {
        // Non-fatal: proceed to clear local mapping regardless
        console.warn('Thread delete error (non-fatal):', e);
      }

      this.chatThreadId.delete(chatId);

      // Clear last_thread_id in DB
      try {
        await UserRegistrationService.updateLastThreadId({
          contactId: chatId.toString(),
          lastThreadId: null,
        });
      } catch (e) {
        console.warn('Failed to clear last_thread_id:', e);
      }

      await this.bot.sendMessage(
        chatId,
        "🧹 История диалога очищена.\nЕсли хотите полностью очистить чат в Telegram, удалите переписку с ботом.",
      );
      return;
    }

    // Handle /new command: start a new thread without deleting previous one (and persist in DB)
    if (text === "/new") {
      const newThreadId = `tg-${chatId}_${Date.now().toString()}`;
      this.chatThreadId.set(chatId, newThreadId);
      try {
        await UserRegistrationService.updateLastThreadId({
          contactId: chatId.toString(),
          lastThreadId: newThreadId,
        });
      } catch (e) {
        console.warn('Failed to persist last_thread_id:', e);
      }
      await this.bot.sendMessage(
        chatId,
        this.escapeMarkdown("🆕 Начат новый диалог. Продолжайте писать."),
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Validate user access
    const validationResult = await UserValidationService.validateUser(chatId.toString());

    if (!validationResult.isValid) {
      // Дополнительная проверка: есть ли запись пользователя в БД
      const existing = await UserRegistrationService.findByContactId(chatId.toString());
      if (!existing) {
          const raw = '👋 Похоже, вы еще не начали работу. Сначала отправьте команду /start, чтобы создать профиль.';
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
        return;
      }

        // Пользователь есть, но не проходит валидацию (например, не активен/нет доступа)
      const rawMsg = validationResult.message || '';
        const raw = `🚫 Доступ запрещен\n\n${rawMsg || 'У вас нет доступа к этому боту'}\n\nАктивируйте учетную запись: /pay`;
      await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
      console.log(`Access denied for chatId ${chatId}: ${validationResult.message}`);
      return;
    }

    console.log(`User ${chatId} validated with API key: ${validationResult.apiKey?.substring(0, 10)}...`);

    try {
      // Pre-flight LLM config checks and notify if missing pieces
      // Ensure cache fresh to avoid stale warnings
      try { await UserValidationService.forceRefreshCache(); } catch {}
      const llm = UserValidationService.getUserLlmConfig(chatId.toString());
      const isActive = UserValidationService.isUserActive(chatId.toString());
      const warnings: string[] = [];
      if (!isActive) warnings.push("Профиль не активен");
      if (!llm?.provider) warnings.push("Не выбран провайдер LLM (provider_llm)");
      if (!llm?.model) warnings.push("Не выбрана модель LLM (model_llm)");
      if (!llm?.apiKey) warnings.push("Нет ключа LLM (api_key_llm)");
      if (warnings.length > 0) {
        const tips: string[] = [];
        if (!isActive) {
          tips.push('После оплаты активируйте учетную запись: /pay');
        }
        if (!llm?.provider || !llm?.model) {
          tips.push('Укажите модель: /llm и затем /addmodel <model>');
        }
        if (!llm?.apiKey) {
          tips.push('Добавьте ключ LLM: /addapikey <YOUR_API_KEY>');
        }
        const helpBlock = tips.length > 0 ? `\n\nКак исправить:\n- ${tips.join('\n- ')}` : '';
        const msg = `⚠️ Настройки LLM неполные:\n- ${warnings.join("\n- ")}\n\nЗапросы к LLM запрещены. Заполните недостающие поля.${helpBlock}`;
      await this.bot.sendMessage(chatId, this.escapeMarkdown(msg), { parse_mode: 'MarkdownV2' });
        return; // жесткая остановка: без корректной LLM конфигурации не идем к LLM
      }

      // Send initial message
      const sentMessage = await this.bot.sendMessage(chatId, "Thinking\\.\\.\\.", {
        parse_mode: "MarkdownV2",
      });
      let currentResponse = "";
      let lastUpdate = Date.now();
      let currentMessageId = sentMessage.message_id;
      const UPDATE_INTERVAL = 500; // Update every 500ms to avoid rate limits

      // Store tool call and result temporarily
      let currentToolCall: { toolName: string; args: any } | null = null;

      // Reuse last thread if exists: check in-memory map first; if absent (e.g., after restart), load from DB
      let threadId = this.chatThreadId.get(chatId);
      if (!threadId) {
        try {
          const dbUser = await UserRegistrationService.findByContactId(chatId.toString());
          if (dbUser?.last_thread_id) {
            threadId = dbUser.last_thread_id;
            this.chatThreadId.set(chatId, threadId);
          }
        } catch (e) {
          console.warn('Failed to load last_thread_id from DB:', e);
        }
      }
      // If still no thread, create a fresh one and persist as last_thread_id
      if (!threadId) {
        const timestamp = Date.now().toString();
        threadId = `tg-${chatId}_${timestamp}`;
        this.chatThreadId.set(chatId, threadId);
        try {
          await UserRegistrationService.updateLastThreadId({
            contactId: chatId.toString(),
            lastThreadId: threadId,
          });
        } catch (e) {
          console.warn('Failed to persist new last_thread_id:', e);
        }
      }

      // Note: DB pointer is updated only when thread changes (create/new/reset)
      
      // Создаем RuntimeContext с данными пользователя  
      console.log('🔧 [TELEGRAM] Creating runtime context for user:', chatId);
      const runtimeContext = new RuntimeContext<UserRuntimeContext>();
      runtimeContext.set("user-chat-id", chatId.toString());
      runtimeContext.set("agent-name", "mcpAgent");
      runtimeContext.set("n8n-api-key", validationResult.apiKey!);
      console.log('🔧 [TELEGRAM] Runtime context created with user data:', {
        userChatId: chatId,
        hasApiKey: !!validationResult.apiKey
      });

      // Получаем MCP toolsets из пула по API ключу
      const pooledClient = getMcpClientForRuntime(runtimeContext);

      // Stream response using the agent with dynamic toolsets and runtimeContext
      const stream = await mcpAgent.stream(text, {
        // Prefer new memory API to ensure consistent threads and persistence
        memory: {
          thread: threadId,
          resource: 'mcpAgent',
        },
        runtimeContext,
        toolsets: await pooledClient.getToolsets(),
        context: [
          {
            role: "system",
            content: `Current user: ${firstName} (${username}). Authenticated user with contact_id: ${chatId}. \n\nIMPORTANT: When using n8n tools (activate-n8n-workflow, create-n8n-credentials), ALWAYS include the parameter user_chat_id: "${chatId}" to use this user's personal API key.`,
          },
        ],
      });

      // Process the full stream
      for await (const chunk of stream.fullStream) {
        let shouldUpdate = false;
        let chunkText = "";

        switch (chunk.type) {
          case "text-delta":
            chunkText = this.escapeMarkdown(chunk.textDelta);
            shouldUpdate = true;
            break;

          case "tool-call":
            // Store tool call but don't show details
            currentToolCall = {
              toolName: chunk.toolName,
              args: chunk.args
            };
            // Don't show tool details in chat
            break;

          case "tool-result":
            // Store complete tool usage in history
            if (currentToolCall) {
              // Extract and process result
              let processedResult = chunk.result;
              
              // Extract content if it exists
              if (chunk.result && chunk.result.content) {
                processedResult = chunk.result.content;
              }
              
              // If result is an array with text objects, extract and parse the JSON
              if (Array.isArray(processedResult) && processedResult.length > 0) {
                const firstItem = processedResult[0];
                if (firstItem && firstItem.type === "text" && firstItem.text) {
                  try {
                    // Parse the JSON string to get actual structured data
                    processedResult = JSON.parse(firstItem.text);
                  } catch (error) {
                    // If parsing fails, keep the text as is
                    processedResult = firstItem.text;
                  }
                }
              }
              
              this.addToToolHistory({
                toolName: currentToolCall.toolName,
                args: currentToolCall.args,
                result: processedResult,
                timestamp: new Date(),
                chatId,
                userId
              });
              currentToolCall = null; // Reset
            }
            // Don't show tool results in chat
            break;

          case "error":
            chunkText = `\n❌ Error: ${this.escapeMarkdown(
              String(chunk.error)
            )}\n`;
            console.error("Error:", chunk.error);
            shouldUpdate = true;
            break;

          case "reasoning":
            // Show reasoning as thinking process
            chunkText = `\n💭 ${this.escapeMarkdown(chunk.textDelta)}\n`;
            shouldUpdate = true;
            break;
        }

        if (shouldUpdate) {
          currentResponse += chunkText;
          const now = Date.now();
          if (now - lastUpdate >= UPDATE_INTERVAL) {
            try {
              currentMessageId = await this.updateOrSplitMessage(
                chatId,
                currentMessageId,
                currentResponse
              );
              lastUpdate = now;
            } catch (error) {
              console.error("Error updating/splitting message:", error);
            }
          }
        }
      }

      // Final update
      await this.updateOrSplitMessage(
        chatId,
        currentMessageId,
        currentResponse
      );
    } catch (error) {
      console.error("Error processing message:", error);
      await this.bot.sendMessage(
        chatId,
        "Sorry, I encountered an error processing your message\\. Please try again\\.",
        {
          parse_mode: "MarkdownV2",
        }
      );
    }
  }
}