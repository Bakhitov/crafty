
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { mcpAgent } from './agents/mcpAgent';
import { PostgresStore } from '@mastra/pg';
import { TelegramIntegration } from './integrations/telegramMcpAgent';
import { UserCacheService } from './services/userCache';
import { UserValidationService } from './services/userValidationService';
import { env } from './config/environment';
import { mcpPool } from './mcp';
import { RuntimeContext } from '@mastra/core/di';
import type { UserRuntimeContext } from './mcp';

// Export tools
export { n8nActivateTool } from './tools/n8n-activate-tool';
export { n8nCredentialsTool } from './tools/n8n-credentials-tool';
// export { weatherTool } from './tools/weather-tool';

// Export MCP utilities
export { createMcpClient, getN8nApiKey, type UserRuntimeContext } from './mcp';

const storage = new PostgresStore({
  connectionString: env.database.url,
});

// Initialize User Cache Service
export const userCache = new UserCacheService(
  env.database.url,
  env.database.cacheRefreshInterval
);

export const mastra = new Mastra({
  storage,
  agents: { mcpAgent },
  workflows: {},
  logger: new PinoLogger({
    name: 'Mastra',
    level: env.logging.level,
  }),
  // Enable HTTP server with middleware to support invocation from any source
  server: {
    cors: { origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] },
    middleware: [
      async (c, next) => {
        // Populate runtimeContext from headers for downstream agent calls
        const runtimeContext = c.get('runtimeContext') as RuntimeContext<UserRuntimeContext>;
        const userChatId = c.req.header('x-user-chat-id');
        const agentName = c.req.header('x-agent-name');
        const n8nApiKey = c.req.header('x-n8n-api-key');

        if (userChatId) runtimeContext.set('user-chat-id', userChatId);
        if (agentName) runtimeContext.set('agent-name', agentName);
        if (n8nApiKey) runtimeContext.set('n8n-api-key', n8nApiKey);

        await next();
      },
    ],
  },
});

// Declare telegram bot variable but don't initialize yet
export let telegramBot: TelegramIntegration | null = null;

// Initialize the user cache and validation service FIRST (with retries)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function initializeCriticalServicesWithRetry(maxAttempts: number = 5): Promise<void> {
  let attempt = 0;
  let lastError: unknown = null;
  const baseDelayMs = 2000;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      console.log(`🚀 Initializing UserCacheService (attempt ${attempt}/${maxAttempts})...`);
      await userCache.initialize();
      console.log('✅ UserCacheService initialized');
      return;
    } catch (err) {
      lastError = err;
      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`❌ UserCacheService init failed (attempt ${attempt}/${maxAttempts}). Retrying in ${backoff}ms...`, err);
      await delay(backoff);
    }
  }
  console.error('❌ UserCacheService failed to initialize after retries. Exiting.');
  throw lastError ?? new Error('UserCacheService init failed');
}

initializeCriticalServicesWithRetry().then(() => {
  // Initialize UserValidationService with the cache instance
  UserValidationService.init(userCache);
  console.log('✅ UserValidationService initialized');
  
  // NOW it's safe to start Telegram bot
  if (env.telegram.botToken) {
    telegramBot = new TelegramIntegration(env.telegram.botToken);
    console.log('✅ Telegram bot initialized and started');
  } else {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set - Telegram integration will be disabled");
  }
  
  // Log application status
  console.log('🚀 Mastra Application Status:', {
    telegram: !!telegramBot,
    cache: userCache.getCacheStats(),
  });
}).catch((error) => {
  console.error('❌ Failed to initialize services (critical):', error);
  process.exit(1);
});

// Graceful shutdown handling
const gracefulShutdown = async (signal: string) => {
  console.log(`📥 Received ${signal}. Starting graceful shutdown...`);
  
  try {
    if (telegramBot) {
      console.log('🛑 Cleaning up Telegram bot resources...');
      await telegramBot.cleanup();
    }

    console.log('🛑 Disconnecting MCP client pool...');
    await mcpPool.disconnectAll();
    
    console.log('🛑 Shutting down user cache...');
    await userCache.shutdown();
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Обработка uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});