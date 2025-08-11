#!/usr/bin/env node

import { N8nApiClient } from 'n8n-mcp/dist/services/n8n-api-client.js';

function parseArgs(argv) {
  const args = { type: '', name: '', data: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type' && argv[i + 1]) { args.type = argv[++i]; continue; }
    if (a === '--name' && argv[i + 1]) { args.name = argv[++i]; continue; }
    if (a === '--data' && argv[i + 1]) { args.data = argv[++i]; continue; }
  }
  return args;
}

async function main() {
  const API_URL = process.env.N8N_API_URL || 'https://n8n.srv945365.hstgr.cloud';
  const API_KEY = process.env.N8N_API_KEY || '';
  if (!API_KEY) {
    console.error('❌ N8N_API_KEY is not set.');
    process.exit(1);
  }

  const { type, name, data } = parseArgs(process.argv);
  const credType = type || process.env.TYPE || 'basicAuth';
  const credName = name || process.env.NAME || `Test ${credType}`;
  const dataRaw = data || process.env.DATA || JSON.stringify({ user: 'demo', password: 'demo123' });

  let credData;
  try {
    credData = JSON.parse(dataRaw);
  } catch (e) {
    console.error('❌ DATA must be valid JSON. Example: {"user":"demo","password":"demo123"}');
    process.exit(2);
  }

  const client = new N8nApiClient({ baseUrl: API_URL, apiKey: API_KEY });

  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const uniqueName = `${credName} - ${timestamp}`;

  try {
    const created = await client.createCredential({ name: uniqueName, type: credType, data: credData });
    console.log('✅ Created credential:');
    console.log(JSON.stringify(created, null, 2));
  } catch (err) {
    console.error('❌ Failed to create credential:');
    console.error(err?.message || err);
    process.exit(3);
  }
}

main();


