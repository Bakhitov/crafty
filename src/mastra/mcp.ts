import { MCPClient } from "@mastra/mcp";
import { RuntimeContext } from "@mastra/core/di";
import { UserValidationService } from "./services/userValidationService";
import { NotFoundError } from "./utils/errors";
import fs from 'node:fs';
import path from 'node:path';
// import { env } from './config/environment';

// Убираем hardcoded API ключ - теперь используем только переменные окружения

// Определяем типы для RuntimeContext (поддерживает динамические пользовательские API ключи)
export type UserRuntimeContext = {
  "user-chat-id"?: string;
  "agent-name"?: string;
  "n8n-api-key"?: string; // Пользовательский API ключ передается через RuntimeContext
  "n8n-url"?: string; // Пользовательский n8n URL
  "channel"?: "telegram" | "whatsapp" | "web" | string;
};

/**
 * Получает API ключ для N8N используя RuntimeContext или fallback логику
 * @param runtimeContext - Контекст выполнения с пользовательскими данными
 * @returns API ключ для N8N
 */
export function getN8nApiKey(runtimeContext?: RuntimeContext<UserRuntimeContext>): string {
  console.log('🔍 [MCP] Getting N8N API Key - Start');
  
  // Проверяем есть ли уже готовый API ключ в контексте
  const contextApiKey = runtimeContext?.get("n8n-api-key");
  console.log('🔍 [MCP] Context API Key:', contextApiKey ? 'Found' : 'Not found');
  if (contextApiKey) {
    console.log('✅ [MCP] Using context API key');
    return contextApiKey;
  }

  // Определяем API ключ как в тулах
  let apiKey: string | null = null;
  
  // Для Telegram пользователей - используем user_chat_id из контекста
  const userChatId = runtimeContext?.get("user-chat-id");
  console.log('🔍 [MCP] User Chat ID:', userChatId || 'not provided');
  
  if (userChatId) {
    apiKey = UserValidationService.getUserApiKey(userChatId);
    console.log('🔍 [MCP] User API Key from cache:', apiKey ? 'Found' : 'Not found');
  }
  
  // Для API запросов - используем статичное имя агента для поиска API ключа
  const agentName = runtimeContext?.get("agent-name");
  console.log('🔍 [MCP] Agent Name:', agentName || 'not provided');
  
  if (!apiKey && agentName === 'n8nAgent') {
    // Для n8nAgent используем переменную окружения как fallback
    apiKey = process.env.N8N_API_KEY || null;
    console.log('🔍 [MCP] Using env API key for n8nAgent:', apiKey ? 'Found' : 'Not found');
  }
  
  // Fallback к переменной окружения если нет других опций
  if (!apiKey) {
    apiKey = process.env.N8N_API_KEY || null;
    console.log('🔍 [MCP] Final fallback to env API key:', apiKey ? 'Found' : 'Not found');
    if (!apiKey) {
      console.error('❌ [MCP] No API key found anywhere!');
      throw new NotFoundError('N8N_API_KEY');
    }
  }

  console.log('🔑 [MCP] Resolved N8N API Key:', {
    userChatId: userChatId || 'not provided',
    agentName: agentName || 'not provided',
    hasContextKey: !!contextApiKey,
    hasUserKey: userChatId ? !!UserValidationService.getUserApiKey(userChatId) : false,
    hasEnvKey: !!process.env.N8N_API_KEY,
    keyPreview: apiKey ? `${apiKey.substring(0, 20)}...` : 'undefined'
  });

  return apiKey;
}

/**
 * Создает MCPClient с динамическим API ключом на основе RuntimeContext
 * @param runtimeContext - Контекст выполнения с пользовательскими данными
 * @param clientId - Уникальный ID для предотвращения конфликтов клиентов
 * @returns MCP клиент с соответствующим API ключом
 */
export function createMcpClient(runtimeContext?: RuntimeContext<UserRuntimeContext>, clientId?: string): MCPClient {
  console.log('🚀 [MCP] Creating MCP Client - Start');
  console.log('🚀 [MCP] Client ID:', clientId || 'auto-generated');

  // Prod/stdio режим
  const apiKey = getN8nApiKey(runtimeContext);
  // Resolve n8n URL: prefer user-specific from cache/context, then env
  let resolvedN8nUrl: string | null = null;
  const userChatId = runtimeContext?.get("user-chat-id");
  const contextUrl = runtimeContext?.get("n8n-url");
  if (contextUrl) {
    resolvedN8nUrl = contextUrl;
  } else if (userChatId) {
    resolvedN8nUrl = UserValidationService.getUserN8nUrl(userChatId);
  }
  if (!resolvedN8nUrl) {
    resolvedN8nUrl = process.env.N8N_API_URL || "https://n8n.srv945365.hstgr.cloud";
  }

  console.log('🚀 [MCP] Creating MCP Client with config:', {
    clientId: clientId || `mcp-client-${Date.now()}`,
    n8nUrl: resolvedN8nUrl,
    hasApiKey: !!apiKey,
    apiKeyPreview: apiKey ? `${apiKey.substring(0, 10)}...` : 'undefined'
  });

  // Определяем команду запуска: локальный бинарь, иначе fallback к npx
  const localBin = path.resolve(process.cwd(), 'node_modules/.bin/n8n-mcp');
  const useLocal = fs.existsSync(localBin);
  const command = useLocal ? localBin : 'npx';
  const args = useLocal ? [] : ['n8n-mcp'];

  // Глобальный переключатель логирования: в development включаем подробные логи по умолчанию
  const isDevEnv = process.env.NODE_ENV === 'development';
  const effectiveLogLevel = process.env.MCP_LOG_LEVEL || (isDevEnv ? 'debug' : 'info');
  const effectiveDisableConsole =
    typeof process.env.MCP_DISABLE_CONSOLE_OUTPUT === 'string'
      ? (process.env.MCP_DISABLE_CONSOLE_OUTPUT.toLowerCase() === 'true' ? 'true' : 'false')
      : (isDevEnv ? 'false' : 'false');

  const mcpClient = new MCPClient({
    id: clientId || `mcp-client-${Date.now()}`,
    timeout: Number(process.env.MCP_CLIENT_TIMEOUT || 90000),
    servers: {
      "n8n-mcp": {
        command,
        args: ["n8n-mcp"],
        env: {
          MCP_MODE: "stdio",
          LOG_LEVEL: effectiveLogLevel,
          DISABLE_CONSOLE_OUTPUT: effectiveDisableConsole,
          N8N_API_URL: resolvedN8nUrl,
          N8N_API_KEY: apiKey
        }
      }
    },
  });

  console.log('✅ [MCP] MCP Client created successfully');
  return mcpClient;
}

// Экспортируем дефолтный клиент для обратной совместимости
export const mcp = createMcpClient();

/**
 * Lightweight MCP client pool keyed by API key to avoid spawning excessive processes
 * when many users have distinct n8n API keys. Reuses clients per key and evicts LRU.
 */
class McpClientPool {
  private readonly keyToClient = new Map<string, MCPClient>();
  private readonly lruKeys: string[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = Number(process.env.MCP_POOL_MAX || 50)) {
    this.maxSize = Math.max(1, maxSize);
  }

  private touch(cacheKey: string): void {
    const idx = this.lruKeys.indexOf(cacheKey);
    if (idx !== -1) this.lruKeys.splice(idx, 1);
    this.lruKeys.push(cacheKey);
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.lruKeys.length > this.maxSize) {
      const oldestKey = this.lruKeys.shift();
      if (!oldestKey) break;
      const client = this.keyToClient.get(oldestKey);
      if (client) {
        try {
          await client.disconnect();
        } catch (e) {
          console.warn('⚠️ [MCP] Error disconnecting evicted client:', e);
        }
        this.keyToClient.delete(oldestKey);
      }
    }
  }

  getClientForConfig(n8nUrl: string, apiKey: string): MCPClient {
    if (!apiKey) {
      throw new NotFoundError('N8N_API_KEY');
    }
    const cacheKey = `${n8nUrl}|${apiKey}`;
    const existing = this.keyToClient.get(cacheKey);
    if (existing) {
      this.touch(cacheKey);
      return existing;
    }
    // Create a new client configured with this apiKey
    const clientId = `n8n-${Buffer.from(n8nUrl).toString('base64').slice(0,8)}-${apiKey.slice(0, 8)}-${Date.now()}`;
    // Глобальный переключатель логирования: в development включаем подробные логи по умолчанию
    const isDevEnv = process.env.NODE_ENV === 'development';
    const effectiveLogLevel = process.env.MCP_LOG_LEVEL || (isDevEnv ? 'debug' : 'error');
    const effectiveDisableConsole =
      typeof process.env.MCP_DISABLE_CONSOLE_OUTPUT === 'string'
        ? (process.env.MCP_DISABLE_CONSOLE_OUTPUT.toLowerCase() === 'true' ? 'true' : 'false')
        : (isDevEnv ? 'false' : 'false');

    const client = new MCPClient({
      id: clientId,
      servers: {
        'n8n-mcp': {
          command: 'npx',
          args: ['n8n-mcp'],
          env: {
            MCP_MODE: 'stdio',
            LOG_LEVEL: effectiveLogLevel,
            DISABLE_CONSOLE_OUTPUT: effectiveDisableConsole,
            N8N_API_URL: n8nUrl,
            N8N_API_KEY: apiKey,
          },
        },
      },
    });
    this.keyToClient.set(cacheKey, client);
    this.touch(cacheKey);
    // Fire-and-forget eviction to keep size under cap
    void this.evictIfNeeded();
    return client;
  }

  async disconnectAll(): Promise<void> {
    const disconnects: Promise<void>[] = [];
    for (const [key, client] of this.keyToClient.entries()) {
      disconnects.push(
        client
          .disconnect()
          .catch((e) => console.warn(`⚠️ [MCP] Error disconnecting client for key ${key.slice(0, 8)}…:`, e)),
      );
    }
    await Promise.all(disconnects);
    this.keyToClient.clear();
    this.lruKeys.length = 0;
  }
}

export const mcpPool = new McpClientPool();

/**
 * Helper to resolve the right MCP client for a given runtime (user) context.
 * Uses user-specific API key when available, falls back to env.
 */
export function getMcpClientForRuntime(runtimeContext?: RuntimeContext<UserRuntimeContext>): MCPClient {
  const apiKey = getN8nApiKey(runtimeContext);
  // Resolve url similarly to createMcpClient
  const userChatId = runtimeContext?.get('user-chat-id');
  const n8nUrl = runtimeContext?.get('n8n-url') || (userChatId ? UserValidationService.getUserN8nUrl(userChatId) : null) || process.env.N8N_API_URL || 'https://n8n.srv945365.hstgr.cloud';
  return mcpPool.getClientForConfig(n8nUrl, apiKey);
}