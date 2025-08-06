
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { mcpAgent } from './agents/mcpAgent';


export const mastra = new Mastra({
 
  agents: { mcpAgent},
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
