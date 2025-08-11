import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { RuntimeContext } from '@mastra/core/di';
import { getN8nApiKey, UserRuntimeContext } from '../mcp';
import { UserValidationService } from '../services/userValidationService';
import { N8nApiClient } from 'n8n-mcp/dist/services/n8n-api-client.js';

const ActionEnum = z.enum(['list', 'create', 'update', 'delete']);

// Break circular type inference by defining schemas first
export const N8nVariablesInputSchema = z.object({
  action: ActionEnum.describe('Operation to perform: list | create | update | delete'),
  // For create
  key: z.string().optional().describe('Variable key (required for create/update/delete)'),
  value: z.string().optional().describe('Variable value (required for create/update)'),
  id: z.string().optional().describe('Variable id (required for update/delete if key not provided)'),
  user_chat_id: z.string().optional().describe('Chat ID of the user for personal API key (optional)'),
  agent_name: z.string().optional().describe('Agent name for API requests (e.g., "n8nAgent")'),
});

export const N8nVariablesOutputSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  data: z.any().optional(),
});

export const n8nVariablesTool = createTool({
  id: 'n8n-variables',
  description:
    'CRUD for n8n Variables: list/create/update/delete. Uses user\'s personal API key if user_chat_id provided; otherwise uses default API key.',
  inputSchema: N8nVariablesInputSchema,
  outputSchema: N8nVariablesOutputSchema,
  execute: async ({ context, runtimeContext }) => {
    return await handleVariables(context, runtimeContext);
  },
});

async function handleVariables(
  context: z.infer<typeof N8nVariablesInputSchema>,
  runtimeContext?: RuntimeContext<UserRuntimeContext>,
): Promise<z.infer<typeof N8nVariablesOutputSchema>> {
  // ensure runtime context available & set routing hints
  const rc = runtimeContext || new RuntimeContext<UserRuntimeContext>();
  if (context.user_chat_id) rc.set('user-chat-id', context.user_chat_id);
  if (context.agent_name) rc.set('agent-name', context.agent_name);

  // resolve API key and base URL
  let apiKey: string | null = null;
  try {
    apiKey = getN8nApiKey(rc);
  } catch (e) {
    return { success: false, message: `N8N API key not found: ${String(e)}` };
  }

  let baseUrl = process.env.N8N_API_URL || 'https://n8n.srv945365.hstgr.cloud';
  const userChatId = rc.get('user-chat-id');
  if (userChatId) {
    const userUrl = UserValidationService.getUserN8nUrl(userChatId);
    if (userUrl) baseUrl = userUrl;
  }

  const client = new N8nApiClient({ baseUrl, apiKey });

  try {
    switch (context.action) {
      case 'list': {
        const vars = await client.getVariables();
        return { success: true, data: vars };
      }
      case 'create': {
        if (!context.key || context.value === undefined) {
          return { success: false, message: 'key and value are required for create' };
        }
        const created = await client.createVariable({ key: context.key, value: context.value, type: 'string' });
        return { success: true, data: created };
      }
      case 'update': {
        // Prefer id; fallback: fetch list and find by key
        let id = context.id || '';
        if (!id) {
          if (!context.key) return { success: false, message: 'Provide id or key for update' };
          const vars = await client.getVariables();
          const found = vars.find((v: any) => v.key === context.key);
          if (!found?.id) return { success: false, message: `Variable with key ${context.key} not found` };
          id = String(found.id);
        }
        if (context.value === undefined) return { success: false, message: 'value is required for update' };
        const updated = await client.updateVariable(id, { value: context.value });
        return { success: true, data: updated };
      }
      case 'delete': {
        // Prefer id; fallback: find by key
        let id = context.id || '';
        if (!id) {
          if (!context.key) return { success: false, message: 'Provide id or key for delete' };
          const vars = await client.getVariables();
          const found = vars.find((v: any) => v.key === context.key);
          if (!found?.id) return { success: false, message: `Variable with key ${context.key} not found` };
          id = String(found.id);
        }
        await client.deleteVariable(id);
        return { success: true, message: 'Deleted' };
      }
      default:
        return { success: false, message: `Unknown action: ${context.action}` };
    }
  } catch (error) {
    return { success: false, message: `n8n variables error: ${error instanceof Error ? error.message : String(error)}` };
  }
}


