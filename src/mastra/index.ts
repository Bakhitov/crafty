
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { mcpAgent } from './agents/mcpAgent';
import { PostgresStore } from '@mastra/pg';
import { TelegramIntegration } from './integrations/telegram';

// Export tools
export { n8nActivateTool } from './tools/n8n-activate-tool';
export { weatherTool } from './tools/weather-tool';

const storage = new PostgresStore({
  connectionString: process.env.DATABASE_URL || "postgresql://user:pass@host:5432/dbname",
});

export const mastra = new Mastra({
  storage,
  agents: { mcpAgent },
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});

// Initialize Telegram bot if token is available
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set in environment variables");
  process.exit(1);
}

// Start the Telegram bot
export const telegramBot = new TelegramIntegration(TELEGRAM_BOT_TOKEN);