import { mcpAgent } from '../mastra/agents/mcpAgent';
import { n8nActivateTool } from '../mastra/tools/n8n-activate-tool';

/**
 * Example demonstrating how to use the n8n workflow activation tool
 * This shows both direct tool usage and agent-based interaction
 */

// Example 1: Direct tool usage
async function activateWorkflowDirectly(workflowId: string) {
  console.log(`Activating workflow ${workflowId} directly...`);
  
  try {
    const result = await n8nActivateTool.execute({
      context: { workflow_id: workflowId }
    });
    
    console.log('Activation result:', result);
    return result;
  } catch (error) {
    console.error('Error activating workflow:', error);
    throw error;
  }
}

// Example 2: Agent-based workflow activation
async function activateWorkflowWithAgent(workflowId: string) {
  console.log(`Using MCP agent to activate workflow ${workflowId}...`);
  
  try {
    const response = await mcpAgent.generate(
      `Please activate the n8n workflow with ID: ${workflowId}`
    );
    
    console.log('Agent response:', response.text);
    return response;
  } catch (error) {
    console.error('Error with agent activation:', error);
    throw error;
  }
}

// Example 3: Complex workflow - get workflow ID from MCP tools and then activate
async function findAndActivateWorkflow(workflowName: string) {
  console.log(`Finding and activating workflow named: ${workflowName}...`);
  
  try {
    const response = await mcpAgent.generate(
      `Please find the workflow named "${workflowName}" and activate it. 
       First, use the MCP tools to list existing workflows and find the one with this name, 
       then use the activation tool to make it active.`
    );
    
    console.log('Agent response:', response.text);
    return response;
  } catch (error) {
    console.error('Error finding and activating workflow:', error);
    throw error;
  }
}

// Example usage
async function runExamples() {
  console.log('=== n8n Workflow Activation Examples ===\n');
  
  // Example 1: Direct activation (you would replace this with a real workflow ID)
  console.log('1. Direct Tool Activation:');
  try {
    await activateWorkflowDirectly('example-workflow-id-123');
  } catch (error) {
    console.log('Expected error for demo workflow ID:', error.message);
  }
  
  console.log('\n2. Agent-based Activation:');
  // This would use the agent to handle the activation
  // Uncomment to test with a real workflow ID:
  // await activateWorkflowWithAgent('real-workflow-id');
  
  console.log('\n3. Find and Activate by Name:');
  // This would use MCP tools to find the workflow first
  // Uncomment to test:
  // await findAndActivateWorkflow('My Test Workflow');
  
  console.log('\n=== Examples completed ===');
}

// Export for use in other files
export {
  activateWorkflowDirectly,
  activateWorkflowWithAgent,
  findAndActivateWorkflow,
  runExamples
};

// Run examples if this file is executed directly
if (require.main === module) {
  runExamples().catch(console.error);
}