import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { RuntimeContext } from '@mastra/core/di';
import { getN8nApiKey, UserRuntimeContext } from '../mcp';
import { env } from '../config/environment';
import { UserValidationService } from '../services/userValidationService';

interface N8nActivateResponse {
  success: boolean;
  active?: boolean;
  message?: string;
  error?: string;
}

export const n8nActivateTool = createTool({
  id: 'activate-n8n-workflow',
  description: 'Activates an n8n workflow by its ID. Uses user\'s personal API key if user_chat_id provided, otherwise uses default API key.',
  inputSchema: z.object({
    workflow_id: z.string().describe('The ID of the n8n workflow to activate'),
    user_chat_id: z.string().optional().describe('Chat ID of the user for personal API key (optional, falls back to default API key)'),
    agent_name: z.string().optional().describe('Agent name for API requests (e.g., "n8nAgent")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    active: z.boolean().optional(),
    message: z.string(),
    workflow_id: z.string(),
  }),
  execute: async ({ context, runtimeContext }) => {
    return await activateN8nWorkflow(context.workflow_id, context.user_chat_id, context.agent_name, runtimeContext);
  },
});

// base URL will be resolved per-user inside the function

const activateN8nWorkflow = async (
  workflowId: string, 
  userChatId?: string, 
  agentName?: string, 
  runtimeContext?: RuntimeContext<UserRuntimeContext>
): Promise<{
  success: boolean;
  active?: boolean;
  message: string;
  workflow_id: string;
}> => {
  // Создаем или обновляем RuntimeContext с переданными данными
  const context = runtimeContext || new RuntimeContext<UserRuntimeContext>();
  if (userChatId) context.set("user-chat-id", userChatId);
  if (agentName) context.set("agent-name", agentName);
  
  // Получаем API ключ через нативную Mastra функцию
  const userApiKey = getN8nApiKey(context);
  
  if (!userApiKey) {
    return {
      success: false,
      message: userChatId 
        ? `User ${userChatId} not found in cache or has no API key`
        : `No API key available`,
      workflow_id: workflowId,
    };
  }

  // Resolve n8n URL: prefer user's custom from cache, else env
  let baseUrl = env.n8n.apiUrl.replace(/\/$/, '');
  if (userChatId) {
    const customUrl = UserValidationService.getUserN8nUrl(userChatId);
    if (customUrl) baseUrl = customUrl.replace(/\/$/, '');
  }

  const apiUrl = `${baseUrl}/api/v1/workflows/${workflowId}/activate`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: buildN8nHeaders(userApiKey),
      body: '',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    let result: N8nActivateResponse;
    try {
      result = await response.json();
    } catch (jsonError) {
      // Some APIs might return empty body on success
      result = { success: true, message: `Workflow ${workflowId} activation request sent successfully` } as N8nActivateResponse;
    }

    return {
      success: true,
      active: result.active,
      message: result.message || `Workflow ${workflowId} activated successfully`,
      workflow_id: workflowId,
    };

  } catch (error) {
    console.error('Error activating n8n workflow:', error);
    
    return {
      success: false,
      message: `Failed to activate workflow ${workflowId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      workflow_id: workflowId,
    };
  }
};

function buildN8nHeaders(apiKey: string): HeadersInit {
  return {
    accept: 'application/json',
    'X-N8N-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
}