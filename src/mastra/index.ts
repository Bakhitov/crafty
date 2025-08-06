
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { mcpAgent } from './agents/mcpAgent';
import { PostgresStore } from '@mastra/pg';

const storage = new PostgresStore({
  connectionString: process.env.DATABASE_URL || "postgresql://user:pass@host:5432/dbname",
});

export const mastra = new Mastra({
  storage,
  agents: { mcpAgent},
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
