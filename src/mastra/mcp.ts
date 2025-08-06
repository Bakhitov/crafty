import { MCPClient } from "@mastra/mcp";
 
// Configure MCPClient to connect to your server(s)
export const mcp = new MCPClient({
  servers: {
    "n8n-railway": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://czlonkowskin8n-mcp-railwaylatest-production-b48b.up.railway.app/mcp",
        "--header",
        "Authorization: Bearer APLrZxK+eeREs52rbHtIP5JFA03cKR8T8MycVml9wVU="
      ]
    }
  },
});