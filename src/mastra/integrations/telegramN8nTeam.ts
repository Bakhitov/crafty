import TelegramBot from "node-telegram-bot-api";
import { RuntimeContext } from "@mastra/core/di";
import { n8nAgent } from "../agents/n8nAgent";
import type { Agent } from "@mastra/core/agent";
import { UserRuntimeContext, mcpPool, getMcpClientForRuntime } from "../mcp";
import { UserValidationService } from "../services/userValidationService";
import { mastra } from "../index";
import { UserRegistrationService } from "../services/userRegistrationService";
import { env } from "../config/environment";

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
  private readonly agentName: string;
  private readonly resolveAgent?: (name: string) => Agent | undefined;
  private readonly resourcePrefix: string;
  private readonly MAX_MESSAGE_LENGTH = 4096; // Telegram's message length limit
  private readonly MAX_RESULT_LENGTH = 500; // Maximum length for tool results
  private toolHistory: ToolUsage[] = []; // Store tool usage history
  private readonly MAX_HISTORY_SIZE = 50; // Keep last 50 tool usages
  private chatThreadId = new Map<number, string>(); // keep latest threadId per chat
  private pendingConfig = new Map<number, { type: 'llm_model_input' | 'llm_api_key_input' | 'n8n_url_input' | 'n8n_api_key_input'; provider?: string }>();

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

  constructor(token: string, options?: { agentName?: string; resolveAgent?: (name: string) => Agent | undefined; resourcePrefix?: string }) {
    this.agentName = options?.agentName || "orchestratorAgent";
    this.resolveAgent = options?.resolveAgent;
    this.resourcePrefix = options?.resourcePrefix || 'telegramN8NTeam';
    // Create a bot instance with explicit allowed updates
    this.bot = new TelegramBot(token, {
      polling: {
        params: {
          allowed_updates: ['message', 'callback_query'],
        },
      },
    } as TelegramBot.ConstructorOptions);

    console.log('[TG] Bot started with polling and allowed_updates for callback_query');

    // Handle incoming messages and callbacks
    this.bot.on("message", this.handleMessage.bind(this));
    this.bot.on('callback_query', this.handleCallback.bind(this));

    // Error logging
    this.bot.on('polling_error', (err) => console.error('[TG] polling_error:', err));
    // @ts-ignore
    this.bot.on('webhook_error', (err) => console.error('[TG] webhook_error:', err));
    // @ts-ignore
    this.bot.on('error', (err) => console.error('[TG] error:', err));
  }

  private buildResourceId(chatId: number | string): string {
    return `${this.resourcePrefix}:${String(chatId)}`;
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  private async sendConfigsSummary(chatId: number): Promise<void> {
    try {
      await UserValidationService.forceRefreshCache();
    } catch {}
    const llm = UserValidationService.getUserLlmConfig(chatId.toString());
    const n8nUrl = UserValidationService.getUserN8nUrl(chatId.toString());
    const n8nKey = UserValidationService.getUserApiKey(chatId.toString());
    const lines: string[] = [];
    lines.push(this.escapeMarkdown('⚙️ Текущие конфигурации'));

    // LLM provider/model shown only if set
    if (llm?.provider) {
      lines.push(this.escapeMarkdown(`LLM provider: ${llm.provider}`));
    }
    if (llm?.model) {
      lines.push(this.escapeMarkdown(`LLM model: ${llm.model}`));
    }
    if (llm?.apiKey) {
      const masked = llm.apiKey.length <= 8
        ? `${llm.apiKey[0]}***${llm.apiKey[llm.apiKey.length - 1]}`
        : `${llm.apiKey.slice(0, 4)}***${llm.apiKey.slice(-4)}`;
      lines.push(this.escapeMarkdown(`LLM key: ${masked}`));
    }

    // Show n8n URL only if user-specific (not default/env)
    const defaultUrl = env.n8n.apiUrl.replace(/\/$/, '');
    const userUrlNorm = (n8nUrl || '').replace(/\/$/, '');
    if (n8nUrl && userUrlNorm && userUrlNorm !== defaultUrl) {
      lines.push(this.escapeMarkdown(`n8n URL: ${userUrlNorm}`));
    }

    // Show user-specific n8n API key only if present (env fallback is not shown)
    if (n8nKey) {
      const masked = n8nKey.length <= 8
        ? `${n8nKey[0]}***${n8nKey[n8nKey.length - 1]}`
        : `${n8nKey.slice(0, 4)}***${n8nKey.slice(-4)}`;
      lines.push(this.escapeMarkdown(`n8n API key: ${masked}`));
    }

    if (lines.length === 1) {
      lines.push(this.escapeMarkdown('Нет пользовательских параметров. Используется конфигурация по умолчанию.'));
    }

    await this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
  }

  private async sendConfigsMenu(chatId: number): Promise<void> {
    // Build inline keyboard
    const keyboard = {
      inline_keyboard: [
        [
          { text: 'LLM: Список моделей', callback_data: 'cfg_llm_list' },
        ],
        [
          { text: 'LLM: Выбрать модель', callback_data: 'cfg_llm_model' },
          { text: 'LLM: Добавить ключ', callback_data: 'cfg_llm_key' },
        ],
        [
          { text: 'n8n: Указать URL', callback_data: 'cfg_n8n_url' },
          { text: 'n8n: Добавить API ключ', callback_data: 'cfg_n8n_key' },
        ],
        [
          { text: 'Открыть мини‑приложение', callback_data: 'cfg_webapp' },
        ],
        [
          { text: '🆕 Новый чат', callback_data: 'cfg_new' },
          { text: '🧹 Сброс чата', callback_data: 'cfg_reset' },
        ],
        [
          { text: 'ℹ️ Инфо', callback_data: 'cfg_info' },
          { text: '💳 Оплата', callback_data: 'cfg_pay' },
        ],
        [
          { text: 'Обновить состояние', callback_data: 'cfg_refresh' }
        ]
      ]
    } as TelegramBot.InlineKeyboardMarkup;

    await this.bot.sendMessage(
      chatId,
      this.escapeMarkdown('Выберите действие:'),
      { reply_markup: keyboard, parse_mode: 'MarkdownV2' }
    );
  }

  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id;
    const data = query.data || '';
    if (!chatId) return;

    try {
      // Stop loading ASAP
      if (query.id) {
        try { await this.bot.answerCallbackQuery(query.id); } catch {}
      }
      console.log('[TG] callback_query data:', data);
      switch (data) {
        case 'cfg_llm_model': {
          // Provider selection keyboard
          const providerButtons = this.llmCatalog.map(p => ({ text: p.name, callback_data: `cfg_llm_provider_${p.key}` }));
          const rows: TelegramBot.InlineKeyboardButton[][] = [];
          for (let i = 0; i < providerButtons.length; i += 2) {
            rows.push(providerButtons.slice(i, i + 2));
          }
          const kb: TelegramBot.InlineKeyboardMarkup = { inline_keyboard: rows };
          await this.bot.sendMessage(chatId, this.escapeMarkdown('Выберите провайдера LLM:'), { reply_markup: kb, parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_llm_list': {
          const entries = this.llmCatalog.map(p => {
            const name = this.escapeMarkdown(p.name);
            const models = this.escapeMarkdown(p.models.join(', '));
            return `LLM: ${name}\nModels: ${models}`;
          });
          const message = entries.join('\n\n');
          await this.bot.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_llm_key': {
          this.pendingConfig.set(chatId, { type: 'llm_api_key_input' });
          await this.bot.sendMessage(chatId, this.escapeMarkdown('Введите LLM API ключ одним сообщением:'), { parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_n8n_url': {
          this.pendingConfig.set(chatId, { type: 'n8n_url_input' });
          await this.bot.sendMessage(chatId, this.escapeMarkdown('Введите ваш N8N URL (пример: https://n8n.example.com):'), { parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_n8n_key': {
          this.pendingConfig.set(chatId, { type: 'n8n_api_key_input' });
          await this.bot.sendMessage(chatId, 'Введите ваш N8N API ключ:');
          break;
        }
        case 'cfg_refresh': {
          await this.sendConfigsSummary(chatId);
          await this.sendConfigsMenu(chatId);
          break;
        }
        case 'cfg_new': {
          const newThreadId = `tg-${chatId}_${Date.now().toString()}`;
          this.chatThreadId.set(chatId, newThreadId);
          try {
            await UserRegistrationService.updateLastThreadId({
              contactId: chatId.toString(),
              lastThreadId: newThreadId,
            });
            // Create memory thread with metadata for visibility under current agent resource
            try {
              const title = 'Новый чат';
              const agent = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
              const memories: any[] = [];
              const agentMem = agent?.getMemory();
              if (agentMem) memories.push(agentMem);
              try {
                const network = (mastra as any).vnext_getNetwork ? (mastra as any).vnext_getNetwork('teamNetwork') : null;
                const netMem = network ? (typeof network.getMemory === 'function' ? network.getMemory() : (network.memory ?? null)) : null;
                if (netMem) memories.push(netMem);
              } catch {}
              for (const mem of memories) {
                try {
                  const maybeCreate = (mem as unknown as { createThread?: (args: { resourceId: string; threadId: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).createThread;
                if (typeof maybeCreate === 'function') {
                  console.log('[THREAD] createThread cfg_new', { resourceId: this.buildResourceId(chatId), threadId: newThreadId, title, user_id: String(chatId) });
                  await maybeCreate({ resourceId: this.buildResourceId(chatId), threadId: newThreadId, metadata: { user_id: String(chatId) }, title });
                }
                } catch (e) { console.warn('[THREAD] createThread cfg_new (mem) error', e); }
              }
            } catch (e) { console.warn('[THREAD] createThread cfg_new error', e); }
          } catch (e) {
            console.warn('Failed to persist last_thread_id:', e);
          }
          await this.bot.sendMessage(chatId, this.escapeMarkdown('🆕 Начат новый диалог. Продолжайте писать.'), { parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_reset': {
          const lastThreadId = this.chatThreadId.get(chatId);
          try {
            const agent = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
            const memory = agent?.getMemory();
            if (memory && lastThreadId) {
              const maybeDelete = (memory as unknown as { deleteThread?: (args: { resourceId: string; threadId: string }) => Promise<void> }).deleteThread;
              if (typeof maybeDelete === 'function') {
                await maybeDelete({ resourceId: this.buildResourceId(chatId), threadId: lastThreadId });
              }
            }
          } catch (e) {
            console.warn('Thread delete error (non-fatal):', e);
          }
          this.chatThreadId.delete(chatId);
          try {
            await UserRegistrationService.updateLastThreadId({ contactId: chatId.toString(), lastThreadId: null });
          } catch (e) {
            console.warn('Failed to clear last_thread_id:', e);
          }
          await this.bot.sendMessage(chatId, '🧹 История диалога очищена.');
          break;
        }
        case 'cfg_pay': {
          const base = env.app.publicUrl || '';
          if (!base) {
            const raw = '💳 Оплата: откройте мини‑приложение (Меню → Открыть мини‑приложение).';
            await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
            break;
          }
          const url = `${base.replace(/\/$/, '')}/miniapp/pay?chatId=${encodeURIComponent(String(chatId))}`;
          const kb: TelegramBot.InlineKeyboardMarkup = {
            inline_keyboard: [[{ text: 'Открыть оплату', web_app: { url } as any }]],
          };
          await this.bot.sendMessage(chatId, this.escapeMarkdown('Откройте страницу оплаты:'), { reply_markup: kb, parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_info': {
          const cap: string[] = [];
          cap.push(this.escapeMarkdown('🤖 Возможности агента'));
          cap.push(this.escapeMarkdown('- Проектирует и собирает n8n-воркфлоу'));
          cap.push(this.escapeMarkdown('- Ищет ноды, управляет credentials'));
          cap.push(this.escapeMarkdown('- Валидирует и деплоит воркфлоу, активирует'));
          cap.push(this.escapeMarkdown('- История инструментов (/logs)'));
          await this.bot.sendMessage(chatId, cap.join('\n'), { parse_mode: 'MarkdownV2' });
          break;
        }
        case 'cfg_webapp': {
          const base = env.app.publicUrl || '';
          if (!base) {
            await this.bot.sendMessage(chatId, this.escapeMarkdown('⚠️ Публичный URL приложения не настроен. Установите APP_PUBLIC_URL в переменных окружения.'), { parse_mode: 'MarkdownV2' });
            break;
          }
          const url = `${base.replace(/\/$/, '')}/miniapp?chatId=${encodeURIComponent(String(chatId))}`;
          const kb: TelegramBot.InlineKeyboardMarkup = {
            inline_keyboard: [[{ text: 'Открыть', web_app: { url } as any }]],
          };
          await this.bot.sendMessage(chatId, this.escapeMarkdown('Откройте мини‑приложение для редактирования настроек:'), { reply_markup: kb, parse_mode: 'MarkdownV2' });
          break;
        }
        default: {
          // Provider selection
          if (data.startsWith('cfg_llm_provider_')) {
            const match = data.match(/^cfg_llm_provider_(.+)$/);
            const provider = match?.[1];
            const providerEntry = this.llmCatalog.find(p => p.key === provider);
            if (!providerEntry) {
              await this.bot.sendMessage(chatId, this.escapeMarkdown('❌ Неизвестный провайдер. Откройте Меню → Конфиги и начните заново.'), { parse_mode: 'MarkdownV2' });
              return;
            }
            const modelButtons = providerEntry.models.map((m, idx) => ({ text: m, callback_data: `cfg_llm_model_idx_${provider}_${idx}` }));
            const rows: TelegramBot.InlineKeyboardButton[][] = [];
            for (let i = 0; i < modelButtons.length; i += 2) {
              rows.push(modelButtons.slice(i, i + 2));
            }
            await this.bot.sendMessage(chatId, this.escapeMarkdown('Выберите модель:'), { reply_markup: { inline_keyboard: rows }, parse_mode: 'MarkdownV2' });
            return;
          }
          if (data.startsWith('cfg_llm_model_idx_')) {
            const match = data.match(/^cfg_llm_model_idx_([^_]+)_(\d+)$/);
          const provider = match?.[1];
            const idxStr = match?.[2];
            const providerEntry = provider ? this.llmCatalog.find(p => p.key === provider) : undefined;
            const index = idxStr ? Number(idxStr) : NaN;
            const model = providerEntry && Number.isInteger(index) ? providerEntry.models[index] : undefined;
          if (!provider || !providerEntry || model === undefined) {
              await this.bot.sendMessage(chatId, this.escapeMarkdown('❌ Не удалось определить модель. Откройте Меню → Конфиги и выберите модель.'), { parse_mode: 'MarkdownV2' });
              return;
            }
            try {
            await UserRegistrationService.updateLlmModel({ contactId: chatId.toString(), provider, model });
              try { await UserValidationService.forceRefreshCache(); } catch {}
              await this.bot.sendMessage(chatId, this.escapeMarkdown(`✅ Модель обновлена: provider=${provider}, model=${model}`), { parse_mode: 'MarkdownV2' });
              await this.sendConfigsMenu(chatId);
            } catch (e) {
              console.error('cfg_llm_model_idx error', e);
              await this.bot.sendMessage(chatId, '❌ Не удалось обновить модель');
            }
            return;
          }
          // Fallback for unknown callback data in cfg_* namespace
          if (data.startsWith('cfg_')) {
            await this.bot.sendMessage(chatId, this.escapeMarkdown('❌ Не удалось обработать действие. Откройте Меню → Конфиги и попробуйте ещё раз.'), { parse_mode: 'MarkdownV2' });
            return;
          }
        }
      }
    } finally {
      // no-op
    }
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
    const normalizedText = (text || '')
      .trim()
      .toLowerCase()
      // strip bot mention like /configs@MyBot
      .replace(/@[^\s]+$/, '');
    const username = (msg.from?.username || "").trim();
    const firstName = (msg.from?.first_name || "").trim();
    const lastName = (msg.from?.last_name || "").trim();
    const userId = msg.from?.id.toString() || `anonymous-${chatId}`;

    if (!text) {
      const raw = "Sorry, I can only process text messages.";
      await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: "MarkdownV2" });
      return;
    }

    // If we are waiting for a value for a pending config action
    const pending = this.pendingConfig.get(chatId);
    if (pending) {
      const value = text.trim();
      try {
        switch (pending.type) {
          case 'llm_model_input': {
            const providerKey = pending.provider!;
            const providerEntry = this.llmCatalog.find(p => p.key === providerKey);
            if (!providerEntry) {
              await this.bot.sendMessage(chatId, this.escapeMarkdown('❌ Неизвестный провайдер. Начните заново: /configs'), { parse_mode: 'MarkdownV2' });
              this.pendingConfig.delete(chatId);
              return;
            }
            const model = value;
            if (!providerEntry.models.map(m => m.toLowerCase()).includes(model.toLowerCase())) {
              await this.bot.sendMessage(chatId, this.escapeMarkdown(`❌ Модель не найдена для провайдера ${providerKey}. Посмотрите список /llm или введите корректную модель.`), { parse_mode: 'MarkdownV2' });
              return;
            }
            await UserRegistrationService.updateLlmModel({ contactId: chatId.toString(), provider: providerKey, model });
            try { await UserValidationService.forceRefreshCache(); } catch {}
            await this.bot.sendMessage(chatId, this.escapeMarkdown(`✅ Модель обновлена: provider=${providerKey}, model=${model}`), { parse_mode: 'MarkdownV2' });
            this.pendingConfig.delete(chatId);
            await this.sendConfigsMenu(chatId);
            return;
          }
          case 'llm_api_key_input': {
            await UserRegistrationService.updateLlmApiKey({ contactId: chatId.toString(), apiKey: value });
            try { await UserValidationService.forceRefreshCache(); } catch {}
            await this.bot.sendMessage(chatId, '✅ Ключ LLM обновлён');
            this.pendingConfig.delete(chatId);
            await this.sendConfigsMenu(chatId);
            return;
          }
          case 'n8n_url_input': {
            try {
              // Basic URL validation
              const u = new URL(value);
              const normalized = u.toString().replace(/\/$/, '');
              await UserRegistrationService.updateN8nUrl({ contactId: chatId.toString(), n8nUrl: normalized });
              try { await UserValidationService.forceRefreshCache(); } catch {}
              await this.bot.sendMessage(chatId, this.escapeMarkdown('✅ N8N URL обновлён. Если это личный сервер — добавьте ключ через пункт меню N8N API Key.'), { parse_mode: 'MarkdownV2' });
            } catch {
              await this.bot.sendMessage(chatId, this.escapeMarkdown('❌ Некорректный URL. Попробуйте ещё раз или начните заново: /configs'), { parse_mode: 'MarkdownV2' });
              return;
            }
            this.pendingConfig.delete(chatId);
            await this.sendConfigsMenu(chatId);
            return;
          }
          case 'n8n_api_key_input': {
            await UserRegistrationService.updateN8nApiKey({ contactId: chatId.toString(), apiKey: value });
            try { await UserValidationService.forceRefreshCache(); } catch {}
            await this.bot.sendMessage(chatId, '✅ Личный N8N API ключ обновлён');
            this.pendingConfig.delete(chatId);
            await this.sendConfigsMenu(chatId);
            return;
          }
        }
      } catch (e) {
        console.error('Config update error', e);
        await this.bot.sendMessage(chatId, '❌ Ошибка обновления конфигурации');
        this.pendingConfig.delete(chatId);
        return;
      }
    }

    // Handle /start: greet based on activation status; create stub user if missing
    if (normalizedText === "/start") {
      const fullName = `${firstName}${lastName ? " " + lastName : ""}`.trim();
      const existing = await UserRegistrationService.findByContactId(chatId.toString());
      if (existing?.contact_id) {
        if (existing.is_active) {
          const raw = '👋 Привет, Crafty Agents! Ваш аккаунт активный. Напишите что-нибудь агенту N8N.';
          await this.bot.sendMessage(chatId, raw);
        } else {
          const raw = '👋 Привет, Crafty Agents!  Ваш аккаунт еще не активирован. Для активации перейдите в Меню → Оплата';
          await this.bot.sendMessage(chatId, raw);
        }
      } else {
        // Create inactive user stub
        await UserRegistrationService.createInactiveUser({
          contactId: chatId.toString(),
          name: fullName || username || `user_${chatId}`,
        });
        const raw = '👋 Привет, Crafty Agents!  Ваш аккаунт еще не активирован. Для активации перейдите в Меню → Оплата';
        await this.bot.sendMessage(chatId, raw);
      }
      return;
    }

    // Unified configs flow (should run before agent interaction)
    if (normalizedText === '/configs') {
      await this.sendConfigsSummary(chatId);
      await this.sendConfigsMenu(chatId);
      return;
    }

    // Handle /pay → open miniapp payment page
    if (normalizedText === "/pay") {
      const base = env.app.publicUrl || '';
      if (!base) {
        const raw = '💳 Оплата: откройте мини‑приложение через Меню → Конфиги → Открыть мини‑приложение.';
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
        return;
      }
      const url = `${base.replace(/\/$/, '')}/miniapp/pay?chatId=${encodeURIComponent(String(chatId))}`;
      const kb: TelegramBot.InlineKeyboardMarkup = {
        inline_keyboard: [[{ text: 'Открыть оплату', web_app: { url } as any }]],
      };
      await this.bot.sendMessage(chatId, this.escapeMarkdown('Откройте страницу оплаты:'), { reply_markup: kb, parse_mode: 'MarkdownV2' });
      return;
    }

    // Handle /addmodel - allow: /addmodel <provider> <model> OR /addmodel <model> (auto-detect provider)
    if (text?.startsWith('/addmodel')) {
      const rawArgs = text.replace('/addmodel', '').trim();
      if (!rawArgs) {
        await this.bot.sendMessage(
          chatId,
          this.escapeMarkdown('ℹ️ Используйте Меню → Конфиги и выберите модель из списка.'),
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
          this.escapeMarkdown('❌ Не удалось определить провайдера/модель. Используйте Меню → Конфиги и выберите модель.'),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      // Validate that model exists for provider
      const providerEntry = this.llmCatalog.find(p => p.key === providerKey);
      if (!providerEntry || !providerEntry.models.map(m => m.toLowerCase()).includes(modelName.toLowerCase())) {
        await this.bot.sendMessage(
          chatId,
          this.escapeMarkdown(`❌ Модель "${modelName}" не найдена у провайдера "${providerKey}". Используйте Меню → Конфиги и выберите доступную модель.`),
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

    // Handle /addn8nurl URL
    if (text?.startsWith('/addn8nurl')) {
      const url = text.replace('/addn8nurl', '').trim();
      if (!url) {
        await this.bot.sendMessage(chatId, this.escapeMarkdown('ℹ️ Использование: /addn8nurl <N8N_URL>\nЕсли вы не хотите подключать свой n8n, будет использован сервер по умолчанию.'), { parse_mode: 'MarkdownV2' });
        return;
      }
      try {
        await UserRegistrationService.updateN8nUrl({ contactId: chatId.toString(), n8nUrl: url });
        try { await UserValidationService.forceRefreshCache(); } catch {}
        await this.bot.sendMessage(chatId, this.escapeMarkdown('✅ N8N URL обновлён. Теперь добавьте личный N8N API ключ командой /addn8napi <KEY>.'), { parse_mode: 'MarkdownV2' });
      } catch (e) {
        console.error('addn8nurl error', e);
        await this.bot.sendMessage(chatId, '❌ Не удалось обновить N8N URL');
      }
      return;
    }

    // Handle /addn8napi KEY
    if (text?.startsWith('/addn8napi')) {
      const key = text.replace('/addn8napi', '').trim();
      if (!key) {
        await this.bot.sendMessage(chatId, 'ℹ️ Использование: /addn8napi <N8N_API_KEY>\nДобавляйте ключ только если вы указали свой N8N URL через /addn8nurl.');
        return;
      }
      try {
        await UserRegistrationService.updateN8nApiKey({ contactId: chatId.toString(), apiKey: key });
        try { await UserValidationService.forceRefreshCache(); } catch {}
        await this.bot.sendMessage(chatId, '✅ Личный N8N API ключ обновлён');
      } catch (e) {
        console.error('addn8napi error', e);
        await this.bot.sendMessage(chatId, '❌ Не удалось обновить N8N API ключ');
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
      cmds.push(this.escapeMarkdown('/configs — настройка LLM и n8n (с кнопками)'));
      cmds.push(this.escapeMarkdown('/llm или /llms — список LLM и моделей (справка)'));
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
        const agent = this.resolveAgent ? this.resolveAgent(this.agentName) : n8nAgent;
        const memory = agent?.getMemory();
        if (memory && lastThreadId) {
          // Best-effort delete across possible resource ids
          const maybeDelete = (memory as unknown as { deleteThread?: (args: { resourceId: string; threadId: string }) => Promise<void> }).deleteThread;
          if (typeof maybeDelete === 'function') {
            const resourceIds = [this.agentName, 'orchestratorAgent', 'n8nAgent'];
            for (const resId of resourceIds) {
              try { await maybeDelete({ resourceId: resId, threadId: lastThreadId }); } catch {}
            }
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
        // Explicitly create memory thread with metadata
        try {
          const title = (msg.text || '').trim().slice(0, 20) || 'Новый чат';
          const agent = this.resolveAgent ? this.resolveAgent(this.agentName) : n8nAgent;
          const memories: any[] = [];
          const agentMem = agent?.getMemory();
          if (agentMem) memories.push(agentMem);
          try {
            const network = (mastra as any).vnext_getNetwork ? (mastra as any).vnext_getNetwork('teamNetwork') : null;
            const netMem = network ? (typeof network.getMemory === 'function' ? network.getMemory() : (network.memory ?? null)) : null;
            if (netMem) memories.push(netMem);
          } catch {}
          for (const mem of memories) {
            try {
              const maybeCreate = (mem as unknown as { createThread?: (args: { resourceId: string; threadId: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).createThread;
              if (typeof maybeCreate === 'function') {
                console.log('[THREAD] createThread /new', { resourceId: this.buildResourceId(chatId), threadId: newThreadId, title, user_id: String(chatId) });
                await maybeCreate({ resourceId: this.buildResourceId(chatId), threadId: newThreadId, metadata: { user_id: String(chatId) }, title });
              }
            } catch (e) { console.warn('[THREAD] createThread /new (mem) error', e); }
          }
        } catch (e) { console.warn('[THREAD] createThread /new error', e); }
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
    // Early: if user record does not exist at all, ask them to run /start to create profile
    try {
      const exists = await UserRegistrationService.findByContactId(chatId.toString());
      if (!exists) {
        const raw = '👋 Похоже, вы еще не начали работу. Сначала отправьте команду /start, чтобы создать профиль.';
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
        return;
      }
    } catch (e) {
      // If DB lookup fails, proceed to validation which will handle and report access issue
      console.warn('User existence check failed, falling back to validation:', e);
    }
    
    const validationResult = await UserValidationService.validateUser(chatId.toString());

    if (!validationResult.isValid) {
      // Дополнительная проверка: есть ли запись пользователя в БД
      const dbUser = await UserRegistrationService.findByContactId(chatId.toString());
      if (!dbUser) {
        const raw = '👋 Похоже, вы еще не начали работу. Сначала отправьте команду /start, чтобы создать профиль.';
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Если в БД уже активен и есть ключ, возможно, не успел обновиться кэш — форсим рефреш и повторяем валидацию
      if (dbUser.is_active && dbUser.n8n_api_key) {
        try { await UserValidationService.forceRefreshCache(); } catch {}
        const recheck = await UserValidationService.validateUser(chatId.toString());
        if (recheck.isValid) {
          // Продолжаем основной поток, не возвращаемся
        } else {
          const raw = '⏳ Профиль обновляется. Попробуйте ещё раз через несколько секунд или нажмите Меню → Обновить состояние.';
          await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
          return;
        }
      } else {
        // Раздельная проверка статуса и наличия n8n_api_key
        const issues: string[] = [];
        if (!dbUser.is_active) issues.push('Профиль не активен — откройте Меню → Оплата');
        if (!dbUser.n8n_api_key) issues.push('Не указан N8N API ключ — откройте Меню → Конфиги');

        const raw = `🚫 Доступ ограничен\n\n${issues.map((s) => `- ${s}`).join('\n')}`;
        await this.bot.sendMessage(chatId, this.escapeMarkdown(raw), { parse_mode: 'MarkdownV2' });
        console.log(`Access limited for chatId ${chatId}: ${issues.join('; ')}`);
        return;
      }
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
      if (!llm?.provider) warnings.push("Не выбран провайдер LLM (например, openai)");
      if (!llm?.model) warnings.push("Не выбрана модель LLM (например, gpt-4.1)");
      if (!llm?.apiKey) warnings.push("Нет ключа LLM (например, sk-proj-1234567890)");
      // N8N pre-flight warnings: if custom URL set but no api key
      const n8nUrl = UserValidationService.getUserN8nUrl(chatId.toString());
      const n8nKey = UserValidationService.getUserApiKey(chatId.toString());
      if (n8nUrl && !n8nKey) {
        warnings.push('Указан собственный N8N URL, но отсутствует N8N API ключ');
      }

      if (warnings.length > 0) {
        const tips: string[] = [];
        if (!isActive) tips.push('После оплаты активируйте учетную запись: Меню → Оплата');
        if (!llm?.provider || !llm?.model) tips.push('Выберите модель: Меню → Конфиги');
        if (!llm?.apiKey) tips.push('Добавьте LLM ключ: Меню → Конфиги');
        if (n8nUrl && !n8nKey) tips.push('Добавьте N8N API ключ: Меню → Конфиги');
        const helpBlock = tips.length > 0 ? `\n\nКак исправить:\n- ${tips.join('\n- ')}` : '';
        const msg = `⚠️ Настройки неполные:\n- ${warnings.join("\n- ")}\n\nЗапросы к LLM запрещены. Заполните недостающие поля.${helpBlock}`;
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

      // Reuse last thread if exists; also reconcile with DB so miniapp changes are respected
      let threadId = this.chatThreadId.get(chatId);
      try {
        const dbUser = await UserRegistrationService.findByContactId(chatId.toString());
        const dbThread = dbUser?.last_thread_id || null;
        if (!threadId && dbThread) {
          threadId = dbThread;
          this.chatThreadId.set(chatId, threadId);
        } else if (threadId && dbThread && dbThread !== threadId) {
          // Prefer DB pointer if it was changed externally (e.g., via miniapp)
          threadId = dbThread;
          this.chatThreadId.set(chatId, threadId);
        }
      } catch (e) {
        console.warn('Failed to reconcile thread with DB:', e);
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
          // Create memory thread with metadata
          try {
            const title = (msg.text || '').trim().slice(0, 20) || 'Новый чат';
            const agent = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
            const memories: any[] = [];
            const agentMem = agent?.getMemory();
            if (agentMem) memories.push(agentMem);
            try {
              const network = (mastra as any).vnext_getNetwork ? (mastra as any).vnext_getNetwork('teamNetwork') : null;
              const netMem = network ? (typeof network.getMemory === 'function' ? network.getMemory() : (network.memory ?? null)) : null;
              if (netMem) memories.push(netMem);
            } catch {}
            for (const mem of memories) {
              try {
                const maybeCreate = (mem as unknown as { createThread?: (args: { resourceId: string; threadId: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).createThread;
                if (typeof maybeCreate === 'function') {
                  console.log('[THREAD] createThread auto', { resourceId: this.buildResourceId(chatId), threadId, title, user_id: String(chatId) });
                  await maybeCreate({ resourceId: this.buildResourceId(chatId), threadId, metadata: { user_id: String(chatId) }, title });
                }
              } catch (e) { console.warn('[THREAD] createThread auto (mem) error', e); }
            }
          } catch (e) { console.warn('[THREAD] createThread auto error', e); }
        } catch (e) {
          console.warn('Failed to persist new last_thread_id:', e);
        }
      }

      // Note: DB pointer is updated only when thread changes (create/new/reset)

      // Ensure the thread exists in the vNext network memory with the unified resourceId
      try {
        const network = (mastra as any).vnext_getNetwork ? (mastra as any).vnext_getNetwork('teamNetwork') : null;
        const netMem = network ? (typeof network.getMemory === 'function' ? network.getMemory() : (network.memory ?? null)) : null;
        if (netMem) {
          const maybeGet = (netMem as unknown as { getThreadById?: (args: { threadId: string }) => Promise<any> }).getThreadById;
          const maybeCreate = (netMem as unknown as { createThread?: (args: { resourceId: string; threadId: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).createThread;
          if (typeof maybeGet === 'function' && typeof maybeCreate === 'function') {
            const existing = await maybeGet({ threadId });
            if (!existing) {
              const title = (msg.text || '').trim().slice(0, 20) || 'Новый чат';
              console.log('[THREAD] ensure exists in network', { resourceId: this.buildResourceId(chatId), threadId, title });
              await maybeCreate({ resourceId: this.buildResourceId(chatId), threadId, title, metadata: { user_id: String(chatId) } });
            }
          }
        }
      } catch (e) {
        console.warn('[THREAD] ensure network existence error', e);
      }

      // Reconcile the agent memory: if thread exists with a different resourceId, recreate under the unified resource
      try {
        const agent = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
        const aMem = agent?.getMemory();
        if (aMem) {
          const aGet = (aMem as unknown as { getThreadById?: (args: { threadId: string }) => Promise<any> }).getThreadById;
          const aDelete = (aMem as unknown as { deleteThread?: (args: { resourceId: string; threadId: string }) => Promise<void> }).deleteThread;
          const aCreate = (aMem as unknown as { createThread?: (args: { resourceId: string; threadId: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).createThread;
          if (typeof aGet === 'function') {
            const t = await aGet({ threadId });
            const desired = this.buildResourceId(chatId);
            const currentRes = t && typeof t.resourceId === 'string' ? t.resourceId : null;
            if (currentRes && currentRes !== desired && typeof aDelete === 'function' && typeof aCreate === 'function') {
              try { await aDelete({ resourceId: currentRes, threadId }); } catch {}
              const title = (msg.text || '').trim().slice(0, 20) || 'Новый чат';
              console.log('[THREAD] recreate agent thread under unified resource', { from: currentRes, to: desired, threadId });
              await aCreate({ resourceId: desired, threadId, title, metadata: { user_id: String(chatId) } });
            } else if (!t && typeof aCreate === 'function') {
              const title = (msg.text || '').trim().slice(0, 20) || 'Новый чат';
              await aCreate({ resourceId: desired, threadId, title, metadata: { user_id: String(chatId) } });
            }
          }
        }
      } catch (e) {
        console.warn('[THREAD] reconcile agent memory error', e);
      }

      // Ensure thread metadata.user_id is set for the active thread and set title from first message (<=20 chars)
      try {
        const agentForMeta = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
        const memForMeta = agentForMeta?.getMemory();
        const maybeGet = (memForMeta as unknown as { getThreadById?: (args: { threadId: string }) => Promise<any> }).getThreadById;
        const maybeUpdate = (memForMeta as unknown as { updateThread?: (args: { id: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).updateThread;
        const memories: any[] = [];
        const agentForMeta2 = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
        const agentMem2 = agentForMeta2?.getMemory();
        if (agentMem2) memories.push(agentMem2);
        try {
          const network2 = (mastra as any).vnext_getNetwork ? (mastra as any).vnext_getNetwork('teamNetwork') : null;
          const netMem2 = network2 ? (typeof network2.getMemory === 'function' ? network2.getMemory() : (network2.memory ?? null)) : null;
          if (netMem2) memories.push(netMem2);
        } catch {}
        for (const mem of memories) {
          try {
            const maybeGet2 = (mem as unknown as { getThreadById?: (args: { threadId: string }) => Promise<any> }).getThreadById;
            const maybeUpdate2 = (mem as unknown as { updateThread?: (args: { id: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).updateThread;
            if (typeof maybeGet2 === 'function' && typeof maybeUpdate2 === 'function') {
              const t = await maybeGet2({ threadId });
              const hasUserId = !!(t && t.metadata && typeof t.metadata === 'object' && 'user_id' in t.metadata);
              const mergedMeta = hasUserId ? t.metadata : ((t && t.metadata && typeof t.metadata === 'object') ? { ...t.metadata, user_id: String(chatId) } : { user_id: String(chatId) });
              const currentTitle = (t && typeof t.title === 'string') ? t.title : '';
              const desiredTitle = (() => {
                const base = (text || '').replace(/\s+/g, ' ').trim();
                if (!base) return '';
                return base.length > 20 ? base.slice(0, 20) : base;
              })();
              if (!hasUserId || (!currentTitle && desiredTitle)) {
                try {
                  console.log('[THREAD] updateThread ensure metadata/title', { id: threadId, user_id: String(chatId), title: !currentTitle && desiredTitle ? desiredTitle : undefined });
                  await maybeUpdate2({ id: threadId, metadata: mergedMeta, title: !currentTitle && desiredTitle ? desiredTitle : undefined });
                } catch (e) { console.warn('[THREAD] updateThread error', e); }
              }
            }
          } catch {}
        }
      } catch {}

      // Создаем RuntimeContext с данными пользователя  
      console.log('🔧 [TELEGRAM] Creating runtime context for user:', chatId);
      const runtimeContext = new RuntimeContext<UserRuntimeContext>();
      runtimeContext.set("user-chat-id", chatId.toString());
      // Выберем корректное имя агента для ключей/привязки: сеть → orchestratorAgent, иначе → n8nAgent
      const useNetwork = String(process.env.USE_VNEXT_NETWORK || '').toLowerCase() === 'true';
      const selectedNetwork = useNetwork && (mastra as any).vnext_getNetwork ? (mastra as any).vnext_getNetwork('teamNetwork') : null;
      const chosenAgentName = 'n8nAgent';
      runtimeContext.set("agent-name", chosenAgentName);
      runtimeContext.set("channel", "telegram");
      runtimeContext.set("n8n-api-key", validationResult.apiKey!);
      console.log('🔧 [TELEGRAM] Runtime context created with user data:', {
        userChatId: chatId,
        hasApiKey: !!validationResult.apiKey
      });

      // Получаем MCP toolsets из пула по API ключу
      const pooledClient = getMcpClientForRuntime(runtimeContext);

      // Route via Mastra vNext Network natively
      const network = selectedNetwork;
        const stream = network
        ? await network.stream(text, {
            // Use chatId as resource to unify working memory across agents in the network
            memory: { thread: threadId, resource: this.buildResourceId(chatId) },
            // Back-compat for older cores
            threadId: threadId,
            resourceId: this.buildResourceId(chatId),
            runtimeContext,
            maxSteps: 30,
            // Передаём весь набор MCP toolsets в сетку агентов, чтобы все видели те же инструменты
            toolsets: await pooledClient.getToolsets(),
          })
        : await ((this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent).stream(text, {
            memory: { thread: threadId, resource: this.buildResourceId(chatId) },
            // Back-compat for older cores
            threadId: threadId,
            resourceId: this.buildResourceId(chatId),
            runtimeContext,
            toolsets: await pooledClient.getToolsets(),
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

      // Post-stream: ensure thread exists and metadata/title persisted
      try {
        const agentForMeta = (this.resolveAgent ? this.resolveAgent(this.agentName) : null) || n8nAgent;
        const memForMeta = agentForMeta?.getMemory();
        const maybeGet = (memForMeta as unknown as { getThreadById?: (args: { threadId: string }) => Promise<any> }).getThreadById;
        const maybeUpdate = (memForMeta as unknown as { updateThread?: (args: { id: string; metadata?: Record<string, unknown>; title?: string }) => Promise<any> }).updateThread;
        if (typeof maybeGet === 'function' && typeof maybeUpdate === 'function') {
          const t = await maybeGet({ threadId });
          if (t) {
            const hasUserId = !!(t.metadata && typeof t.metadata === 'object' && 'user_id' in t.metadata);
            const mergedMeta = hasUserId ? t.metadata : ((t.metadata && typeof t.metadata === 'object') ? { ...t.metadata, user_id: String(chatId) } : { user_id: String(chatId) });
            const currentTitle = (t && typeof t.title === 'string') ? t.title : '';
            const desiredTitle = (() => {
              const base = (text || '').replace(/\s+/g, ' ').trim();
              if (!base) return '';
              return base.length > 20 ? base.slice(0, 20) : base;
            })();
            if (!hasUserId || (!currentTitle && desiredTitle)) {
              console.log('[THREAD] post-stream updateThread', { id: threadId, user_id: String(chatId), title: !currentTitle && desiredTitle ? desiredTitle : undefined });
              await maybeUpdate({ id: threadId, metadata: mergedMeta, title: !currentTitle && desiredTitle ? desiredTitle : undefined });
            }
          }
        }
      } catch (e) {
        console.warn('[THREAD] post-stream ensure metadata/title error', e);
      }
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