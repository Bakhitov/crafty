import { MCPClient } from "@mastra/mcp";
import { RuntimeContext } from "@mastra/core/di";
import { UserValidationService } from "./services/userValidationService";
import { NotFoundError } from "./utils/errors";
import fs from 'node:fs';
import path from 'node:path';

// Убираем hardcoded API ключ - теперь используем только переменные окружения

// Определяем типы для RuntimeContext (поддерживает динамические пользовательские API ключи)
export type UserRuntimeContext = {
  "user-chat-id"?: string;
  "agent-name"?: string;
  "n8n-api-key"?: string; // Пользовательский API ключ передается через RuntimeContext
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
  
  if (!apiKey && agentName === 'mcpAgent') {
    // Для mcpAgent используем переменную окружения как fallback
    apiKey = process.env.N8N_API_KEY || null;
    console.log('🔍 [MCP] Using env API key for mcpAgent:', apiKey ? 'Found' : 'Not found');
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
  
  const apiKey = getN8nApiKey(runtimeContext);
  
  console.log('🚀 [MCP] Creating MCP Client with config:', {
    clientId: clientId || `mcp-client-${Date.now()}`,
    n8nUrl: "https://n8n.srv945365.hstgr.cloud",
    hasApiKey: !!apiKey,
    apiKeyPreview: apiKey ? `${apiKey.substring(0, 10)}...` : 'undefined'
  });
  
  // Определяем команду запуска: локальный бинарь, иначе fallback к npx
  const localBin = path.resolve(process.cwd(), 'node_modules/.bin/n8n-mcp');
  const useLocal = fs.existsSync(localBin);
  const command = useLocal ? localBin : 'npx';
  const args = useLocal ? [] : ['n8n-mcp'];

  // Создаем MCP клиент с правильным API ключом и уникальным ID
  const mcpClient = new MCPClient({
    id: clientId || `mcp-client-${Date.now()}`,
    timeout: Number(process.env.MCP_CLIENT_TIMEOUT || 90000),
    servers: {
      "n8n-mcp": {
        command,
        args,
        env: {
          MCP_MODE: "stdio",
          LOG_LEVEL: process.env.MCP_LOG_LEVEL || "info",
          DISABLE_CONSOLE_OUTPUT: process.env.MCP_DISABLE_CONSOLE_OUTPUT === 'true' ? 'true' : 'false',
          N8N_API_URL: process.env.N8N_API_URL || "https://n8n.srv945365.hstgr.cloud",
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
  private readonly apiKeyToClient = new Map<string, MCPClient>();
  private readonly lruKeys: string[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = Number(process.env.MCP_POOL_MAX || 50)) {
    this.maxSize = Math.max(1, maxSize);
  }

  private touch(apiKey: string): void {
    const idx = this.lruKeys.indexOf(apiKey);
    if (idx !== -1) this.lruKeys.splice(idx, 1);
    this.lruKeys.push(apiKey);
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.lruKeys.length > this.maxSize) {
      const oldestKey = this.lruKeys.shift();
      if (!oldestKey) break;
      const client = this.apiKeyToClient.get(oldestKey);
      if (client) {
        try {
          await client.disconnect();
        } catch (e) {
          console.warn('⚠️ [MCP] Error disconnecting evicted client:', e);
        }
        this.apiKeyToClient.delete(oldestKey);
      }
    }
  }

  getClientForApiKey(apiKey: string): MCPClient {
    if (!apiKey) {
      throw new NotFoundError('N8N_API_KEY');
    }
    const existing = this.apiKeyToClient.get(apiKey);
    if (existing) {
      this.touch(apiKey);
      return existing;
    }
    // Create a new client configured with this apiKey
    const clientId = `n8n-${apiKey.slice(0, 8)}-${Date.now()}`;
    const client = new MCPClient({
      id: clientId,
      servers: {
        'n8n-mcp': {
          command: 'npx',
          args: ['n8n-mcp'],
          env: {
            MCP_MODE: 'stdio',
            LOG_LEVEL: process.env.MCP_LOG_LEVEL || 'error',
            DISABLE_CONSOLE_OUTPUT: process.env.MCP_DISABLE_CONSOLE_OUTPUT === 'true' ? 'true' : 'false',
            N8N_API_URL: process.env.N8N_API_URL || 'https://n8n.srv945365.hstgr.cloud',
            N8N_API_KEY: apiKey,
          },
        },
      },
    });
    this.apiKeyToClient.set(apiKey, client);
    this.touch(apiKey);
    // Fire-and-forget eviction to keep size under cap
    void this.evictIfNeeded();
    return client;
  }

  async disconnectAll(): Promise<void> {
    const disconnects: Promise<void>[] = [];
    for (const [key, client] of this.apiKeyToClient.entries()) {
      disconnects.push(
        client
          .disconnect()
          .catch((e) => console.warn(`⚠️ [MCP] Error disconnecting client for key ${key.slice(0, 8)}…:`, e)),
      );
    }
    await Promise.all(disconnects);
    this.apiKeyToClient.clear();
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
  return mcpPool.getClientForApiKey(apiKey);
}