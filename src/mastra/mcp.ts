import { MCPClient } from "@mastra/mcp";
 
// Configure MCPClient to connect to your server(s)
export const mcp = new MCPClient({
  servers: {
    "n8n-mcp": {
      "command": "npx",
      "args": ["n8n-mcp"],
      "env": {
        "MCP_MODE": "stdio",
        "LOG_LEVEL": "error",
        "DISABLE_CONSOLE_OUTPUT": "true",
        "N8N_API_URL": "https://n8n.srv945365.hstgr.cloud",
        "N8N_API_KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZDEwMDNhYS0yNWM1LTQ3YTYtOTNhYy01NjNkM2Y2NWE5M2UiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzU0NDg0NDgwLCJleHAiOjE5MDMyMDEyMDB9.O_zo3cvkA3bVKjr7hynM7vpORiFH9D-4pZbWe0eWfKA"
      }
    }
  },
});