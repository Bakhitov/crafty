import TelegramBot from "node-telegram-bot-api";
import { RuntimeContext } from "@mastra/core/di";
import { mcpAgent } from "../agents/mcpAgent";
import { UserRuntimeContext, mcpPool, getMcpClientForRuntime } from "../mcp";
import { UserValidationService } from "../services/userValidationService";

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
    const userId = msg.from?.id.toString() || `anonymous-${chatId}`;

    if (!text) {
      await this.bot.sendMessage(
        chatId,
        "Sorry, I can only process text messages\\.",
        {
          parse_mode: "MarkdownV2",
        }
      );
      return;
    }

    // Handle /logs command
    if (text === "/logs") {
      await this.handleLogsCommand(chatId);
      return;
    }

    // Handle /reset command: delete last thread and clear mapping
    if (text === "/reset") {
      const lastThreadId = this.chatThreadId.get(chatId);
      try {
        const memory = mcpAgent.getMemory();
        if (memory && lastThreadId) {
          // Best-effort delete of the thread if supported by memory implementation
          const maybeDelete = (memory as unknown as { deleteThread?: (args: { resourceId: string; threadId: string }) => Promise<void> }).deleteThread;
          if (typeof maybeDelete === 'function') {
            await maybeDelete({
              resourceId: chatId.toString(),
              threadId: lastThreadId,
            });
          }
        }
      } catch (e) {
        // Non-fatal: proceed to clear local mapping regardless
        console.warn('Thread delete error (non-fatal):', e);
      }

      this.chatThreadId.delete(chatId);

      await this.bot.sendMessage(
        chatId,
        "🧹 История диалога очищена.\nЕсли хотите полностью очистить чат в Telegram, удалите переписку с ботом.",
      );
      return;
    }

    // Validate user access
    const validationResult = await UserValidationService.validateUser(chatId.toString());
    
    if (!validationResult.isValid) {
      await this.bot.sendMessage(
        chatId,
        `🚫 *Доступ запрещен*\n\n${this.escapeMarkdown(validationResult.message || 'У вас нет доступа к этому боту')}\n\nОбратитесь к администратору для получения доступа\\.`,
        {
          parse_mode: "MarkdownV2",
        }
      );
      console.log(`Access denied for chatId ${chatId}: ${validationResult.message}`);
      return;
    }

    console.log(`User ${chatId} validated with API key: ${validationResult.apiKey?.substring(0, 10)}...`);

    try {
      // Pre-flight LLM config checks and notify if missing pieces
      const llm = UserValidationService.getUserLlmConfig(chatId.toString());
      const isActive = UserValidationService.isUserActive(chatId.toString());
      const warnings: string[] = [];
      if (!isActive) warnings.push("Профиль не активен");
      if (!llm?.provider) warnings.push("Не выбран провайдер LLM (provider_llm)");
      if (!llm?.model) warnings.push("Не выбрана модель LLM (model_llm)");
      if (!llm?.apiKey) warnings.push("Нет ключа LLM (api_key_llm)");
      if (warnings.length > 0) {
        await this.bot.sendMessage(
          chatId,
          `⚠️ Настройки LLM неполные:\n- ${warnings.join("\n- ")}\n\nЗапросы к LLM запрещены. Заполните недостающие поля.`,
        );
        return; // жесткая остановка: без кеша не идем к LLM
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

      // Create a new thread for new users; reuse latest for existing users
      let threadId = this.chatThreadId.get(chatId);
      if (!threadId) {
        const timestamp = Date.now().toString();
        threadId = `tg-${chatId}_${timestamp}`;
        this.chatThreadId.set(chatId, threadId);
      }
      
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
          resource: chatId.toString(),
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