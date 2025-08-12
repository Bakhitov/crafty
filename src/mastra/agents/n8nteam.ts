import { Agent } from "@mastra/core/agent";
import { RuntimeContext as DIContext } from "@mastra/core/di";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import fs from "node:fs";
import path from "node:path";
import { UserValidationService } from "../services/userValidationService";
import type { UserRuntimeContext } from "../mcp";
import { resolveLlmModel } from "../utils/llmProviderFactory";
import { n8nActivateTool } from "../tools/n8n-activate-tool";
import { n8nVariablesTool } from "../tools/n8n-variables-tool";
import { n8nCredentialsCrudTool } from "../tools/n8n-credentials-crud-tool";
import { getMcpClientForRuntime } from "../mcp";

const PROMPTS_DIR = path.resolve(process.cwd(), "agents_promtps");

function readPromptFile(fileName: string): string {
  const full = path.join(PROMPTS_DIR, fileName);
  try {
    return fs.readFileSync(full, "utf8");
  } catch {
    return `Instructions file not found: ${fileName}`;
  }
}

function unifiedModelResolver() {
  return ({ runtimeContext }: { runtimeContext: DIContext<UserRuntimeContext> }) => {
    const chatId = (runtimeContext as DIContext<UserRuntimeContext>).get("user-chat-id");
    if (chatId) {
      const llm = UserValidationService.getUserLlmConfig(chatId);
      if (llm?.provider && llm.model && llm.apiKey) {
        return resolveLlmModel({ provider: llm.provider, model: llm.model, apiKey: llm.apiKey }) as any;
      }
    }
    const fallbackProvider = (process.env.DEFAULT_LLM_PROVIDER || "openai").toLowerCase();
    const fallbackModel = process.env.DEFAULT_LLM_MODEL || "gpt-4.1";
    return resolveLlmModel({ provider: fallbackProvider, model: fallbackModel, apiKey: null }) as any;
  };
}

const orchestratorPrompt = readPromptFile("n8n-master-orchestrator.md");
const architectPrompt = readPromptFile("n8n-workflow-architect.md");
const builderPrompt = readPromptFile("n8n-workflow-builder.md");
const deployerPrompt = readPromptFile("n8n-workflow-deployer.md");
const qaPrompt = readPromptFile("n8n-workflow-qa.md");

// Helper tool to ask another agent
function createAskAgentTool(toolId: string, targetAgentKey: string, description: string) {
  return createTool({
    id: toolId,
    description,
    inputSchema: z.object({
      prompt: z.string().describe("Question or task to delegate to the target agent"),
    }),
    outputSchema: z.object({ text: z.string() }).optional(),
    execute: async ({ context, mastra, threadId, resourceId }) => {
      const target = mastra?.getAgent(targetAgentKey);
      if (!target) {
        return { text: `Agent ${targetAgentKey} not found` } as any;
      }
      const delegatedThread = threadId ? `${String(threadId)}::${targetAgentKey}` : undefined;
      const stream = await target.stream(context.prompt, {
        memory: delegatedThread && resourceId ? { thread: delegatedThread, resource: String(resourceId) } : undefined,
      });
      let text = "";
      for await (const chunk of stream.textStream) text += chunk;
      return { text } as any;
    },
  });
}

const ask_architect = createAskAgentTool(
  "ask_architect",
  "architectAgent",
  "Consult the Workflow Architect for high-level design, node selection and credentials plan",
);
const ask_builder = createAskAgentTool(
  "ask_builder",
  "builderAgent",
  "Consult the Workflow Builder to assemble nodes and configurations",
);
const ask_deployer = createAskAgentTool(
  "ask_deployer",
  "deployerAgent",
  "Consult the Workflow Deployer to deploy/update/activate n8n workflows",
);
const ask_qa = createAskAgentTool(
  "ask_qa",
  "qaAgent",
  "Consult the QA agent to validate nodes, connections and expressions",
);

export const architectAgent = new Agent({
  name: "architectAgent",
  description: "Workflow Architect: designs high-level n8n workflow architecture, selects nodes and credentials plan.",
  instructions: architectPrompt,
  model: unifiedModelResolver(),
  tools: async ({ runtimeContext }) => {
    // Показываем ВСЕ MCP‑инструменты без фильтрации
    try {
      const client = getMcpClientForRuntime(runtimeContext as unknown as DIContext<UserRuntimeContext>);
      const all = await client.getTools();
      return all as Record<string, any>;
    } catch {
      return {};
    }
  },
  memory: new Memory({
    options: {
      workingMemory: {
        enabled: true,
        template: `# Working memory
- **Workflow name**: 
- **Workflow ID**:
- **Workflow nodes and their configurations**:
- **Workflow JSON structure draft**: {
  "name": example_name,
  "nodes": 
  ...}
- **Status completed**:
- **Credentials**: 
- **Variables**: 
`,
      },
      threads: { generateTitle: true },
      semanticRecall: false,
    },
  }),
  defaultGenerateOptions: { maxSteps: 30 },
  defaultStreamOptions: { maxSteps: 30 },
});

export const builderAgent = new Agent({
  name: "builderAgent",
  description: "Workflow Builder: assembles n8n nodes, sets configs, expressions and connections from an approved design.",
  instructions: builderPrompt,
  model: unifiedModelResolver(),
  tools: async ({ runtimeContext }) => {
    try {
      const client = getMcpClientForRuntime(runtimeContext as unknown as DIContext<UserRuntimeContext>);
      const all = await client.getTools();
      return { ...all, "n8n-credentials-crud": n8nCredentialsCrudTool } as Record<string, any>;
    } catch {
      return { "n8n-credentials-crud": n8nCredentialsCrudTool } as Record<string, any>;
    }
  },
  memory: new Memory({
    options: {
      workingMemory: {
        enabled: true,
        template: `# Working memory
- **Workflow name**: 
- **Workflow ID**:
- **Workflow nodes and their configurations**:
- **Workflow JSON structure draft**: {
  "name": example_name,
  "nodes": 
  ...}
- **Status completed**:
- **Credentials**: 
- **Variables**: 
`,
      },
      threads: { generateTitle: true },
      semanticRecall: false,
    },
  }),
  defaultGenerateOptions: { maxSteps: 30 },
  defaultStreamOptions: { maxSteps: 30 },
});

export const deployerAgent = new Agent({
  name: "deployerAgent",
  description: "Workflow Deployer: deploys/updates workflows to n8n and activates them using provided API keys.",
  instructions: deployerPrompt,
  model: unifiedModelResolver(),
  memory: new Memory({
    options: {
      workingMemory: {
        enabled: true,
        template: `# Working memory
- **Workflow name**: 
- **Workflow ID**:
- **Workflow nodes and their configurations**:
- **Workflow JSON structure draft**: {
  "name": example_name,
  "nodes": 
  ...}
- **Status completed**:
- **Credentials**: 
- **Variables**: 
`,
      },
      threads: { generateTitle: true },
      semanticRecall: false,
    },
  }),
  defaultGenerateOptions: { maxSteps: 30 },
  defaultStreamOptions: { maxSteps: 30 },
  tools: async ({ runtimeContext }) => {
    try {
      const client = getMcpClientForRuntime(runtimeContext as unknown as DIContext<UserRuntimeContext>);
      const all = await client.getTools();
      return { ...all, "activate-n8n-workflow": n8nActivateTool } as Record<string, any>;
    } catch {
      return { "activate-n8n-workflow": n8nActivateTool } as Record<string, any>;
    }
  },
});

export const qaAgent = new Agent({
  name: "qaAgent",
  description: "QA: validates node configs, connections and expressions; performs pre/post-deploy checks.",
  instructions: qaPrompt,
  model: unifiedModelResolver(),
  tools: async ({ runtimeContext }) => {
    try {
      const client = getMcpClientForRuntime(runtimeContext as unknown as DIContext<UserRuntimeContext>);
      const all = await client.getTools();
      return { ...all, "n8n-credentials-crud": n8nCredentialsCrudTool } as Record<string, any>;
    } catch {
      return { "n8n-credentials-crud": n8nCredentialsCrudTool } as Record<string, any>;
    }
  },
  memory: new Memory({
    options: {
      workingMemory: {
        enabled: true,
        template: `# Working memory
- **Workflow name**: 
- **Workflow ID**:
- **Workflow nodes and their configurations**:
- **Workflow JSON structure draft**: {
  "name": example_name,
  "nodes": 
  ...}
- **Status completed**:
- **Credentials**: 
- **Variables**: 
`,
      },
      threads: { generateTitle: true },
      semanticRecall: false,
    },
  }),
  defaultGenerateOptions: { maxSteps: 30 },
  defaultStreamOptions: { maxSteps: 30 },
});

export const orchestratorAgent = new Agent({
  name: "orchestratorAgent",
  description: "Orchestrator: routes tasks between Architect, Builder, QA and Deployer; manages credentials and activations.",
  instructions: `${orchestratorPrompt}\n\nYou are the lead orchestrator. When needed, call tools:\n- ask_architect for high-level design and node planning\n- ask_builder for building nodes and configs\n- ask_qa for validations before/after build\n- ask_deployer for deployment/activation.\nAlso use n8n credential and activation tools directly when appropriate.`,
  model: unifiedModelResolver(),
  tools: async ({ runtimeContext }) => {
    const base = {
      ask_architect,
      ask_builder,
      ask_deployer,
      ask_qa,
      "activate-n8n-workflow": n8nActivateTool,
      "n8n-variables": n8nVariablesTool,
      "n8n-credentials-crud": n8nCredentialsCrudTool,
    } as Record<string, any>;

    // Orchestrator also has MCP tools for discovery and validation to supervise flow
    try {
      const client = getMcpClientForRuntime(runtimeContext as unknown as DIContext<UserRuntimeContext>);
      const mcpTools = await client.getTools();
      return { ...mcpTools, ...base };
    } catch {
      return base;
    }
  },
  memory: new Memory({
    options: {
      workingMemory: {
        enabled: true,
        template: `# Working memory
- **Workflow name**: 
- **Workflow ID**:
- **Workflow nodes and their configurations**:
- **Workflow JSON structure draft**: {
  "name": example_name,
  "nodes": 
  ...}
- **Status completed**:
- **Credentials**: 
- **Variables**: 
`,
      },
      threads: { generateTitle: true },
      semanticRecall: false,
    },
  }),
  defaultGenerateOptions: { maxSteps: 30 },
  defaultStreamOptions: { maxSteps: 30 },
});


