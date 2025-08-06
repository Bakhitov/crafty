import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

interface N8nActivateResponse {
  success: boolean;
  active?: boolean;
  message?: string;
  error?: string;
}

export const n8nActivateTool = createTool({
  id: 'activate-n8n-workflow',
  description: 'Activates an n8n workflow by its ID using the provided API endpoint',
  inputSchema: z.object({
    workflow_id: z.string().describe('The ID of the n8n workflow to activate'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    active: z.boolean().optional(),
    message: z.string(),
    workflow_id: z.string(),
  }),
  execute: async ({ context }) => {
    return await activateN8nWorkflow(context.workflow_id);
  },
});

const activateN8nWorkflow = async (workflowId: string): Promise<{
  success: boolean;
  active?: boolean;
  message: string;
  workflow_id: string;
}> => {
  const apiUrl = `https://n8n.srv945365.hstgr.cloud/api/v1/workflows/${workflowId}/activate`;
  const apiKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZDEwMDNhYS0yNWM1LTQ3YTYtOTNhYy01NjNkM2Y2NWE5M2UiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzU0NDg0NDgwLCJleHAiOjE5MDMyMDEyMDB9.O_zo3cvkA3bVKjr7hynM7vpORiFH9D-4pZbWe0eWfKA';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
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
      result = { success: true, message: `Workflow ${workflowId} activation request sent successfully` };
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