import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { RuntimeContext } from '@mastra/core/di';
import { getN8nApiKey, UserRuntimeContext } from '../mcp';
import { UserValidationService } from '../services/userValidationService';
import { N8nApiClient } from 'n8n-mcp/dist/services/n8n-api-client.js';
import { Client as PgClient } from 'pg';

const CredAction = z.enum(['list', 'get', 'create', 'update', 'delete']);

// Break circular inference by hoisting schemas
export const N8nCredsInputSchema = z.object({
  action: CredAction,
  id: z.string().optional().describe('Credential id (get/update/delete)'),
  name: z.string().optional().describe('Display name (create/update)'),
  type: z.string().optional().describe('Credential type (create)'),
  data: z.record(z.any()).optional().describe('Credential data map (create/update)'),
  search_term: z.string().optional().describe('Search term for listing credential TYPES via Supabase (list action)'),
  user_chat_id: z.string().optional(),
  agent_name: z.string().optional(),
  params: z
    .object({ limit: z.number().optional(), cursor: z.string().optional() })
    .optional()
    .describe('Optional list parameters'),
});

export const N8nCredsOutputSchema = z.object({ success: z.boolean(), message: z.string().optional(), data: z.any().optional() });

export const n8nCredentialsCrudTool = createTool({
  id: 'n8n-credentials-crud',
  description:
    'Direct CRUD for n8n credentials via n8n API: list/get/create/update/delete. Uses user\'s API key if user_chat_id is provided; otherwise falls back to default API key.',
  inputSchema: N8nCredsInputSchema,
  outputSchema: N8nCredsOutputSchema,
  execute: async ({ context, runtimeContext }) => {
    return crudCredentials(context, runtimeContext);
  },
});

async function crudCredentials(
  context: z.infer<typeof N8nCredsInputSchema>,
  runtimeContext?: RuntimeContext<UserRuntimeContext>,
) {
  const rc = runtimeContext || new RuntimeContext<UserRuntimeContext>();
  if (context.user_chat_id) rc.set('user-chat-id', context.user_chat_id);
  if (context.agent_name) rc.set('agent-name', context.agent_name);

  let apiKey: string;
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
        // For listing, use Supabase (types/metadata) as in discovery tool
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) return { success: false, message: 'DATABASE_URL is not set for listing credential types' };
        const pg = new PgClient({ connectionString });
        try {
          await pg.connect();
          const term = (context.search_term || '').trim();
          let res;
          if (term) {
            // Try exact name match first
            res = await pg.query(
              `SELECT name, "displayName", "documentationUrl", properties
               FROM credentials
               WHERE LOWER(name) = LOWER($1)
               LIMIT 1`,
              [term],
            );
            if (res.rows.length === 0) {
              // Partial by displayName
              res = await pg.query(
                `SELECT name, "displayName", "documentationUrl", properties
                 FROM credentials
                 WHERE LOWER("displayName") LIKE LOWER($1)
                 LIMIT 10`,
                [`%${term}%`],
              );
            }
            if (res.rows.length === 0) {
              // Partial by documentationUrl
              res = await pg.query(
                `SELECT name, "displayName", "documentationUrl", properties
                 FROM credentials
                 WHERE LOWER("documentationUrl") LIKE LOWER($1)
                 LIMIT 10`,
                [`%${term}%`],
              );
            }
          } else {
            res = await pg.query(
              `SELECT name, "displayName", "documentationUrl"
               FROM credentials
               ORDER BY "displayName" ASC
               LIMIT 25`,
            );
          }
          return { success: true, data: res.rows };
        } finally {
          try { await pg.end(); } catch {}
        }
      }
      case 'get': {
        if (!context.id) return { success: false, message: 'id is required for get' };
        const res = await client.getCredential(context.id);
        return { success: true, data: res };
      }
      case 'create': {
        if (!context.name || !context.type || !context.data)
          return { success: false, message: 'name, type and data are required for create' };
        const res = await client.createCredential({ name: context.name, type: context.type, data: context.data });
        return { success: true, data: res };
      }
      case 'update': {
        if (!context.id) return { success: false, message: 'id is required for update' };
        if (!context.name && !context.data) return { success: false, message: 'Provide name and/or data for update' };
        const payload: any = {};
        if (context.name) payload.name = context.name;
        if (context.data) payload.data = context.data;
        const res = await client.updateCredential(context.id, payload);
        return { success: true, data: res };
      }
      case 'delete': {
        if (!context.id) return { success: false, message: 'id is required for delete' };
        await client.deleteCredential(context.id);
        return { success: true, message: 'Deleted' };
      }
      default:
        return { success: false, message: `Unknown action: ${context.action}` };
    }
  } catch (error) {
    // Known caveat: Some n8n instances restrict credentials endpoints; surface a clear message
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `n8n credentials error: ${msg}` };
  }
}


