#!/usr/bin/env node

// Usage:
//   export DATABASE_URL=...
//   export N8N_API_URL=...
//   export N8N_API_KEY=...
//   node scripts/create-n8n-credential.mjs --type telegramApi --name "My Telegram Bot" --data '{"accessToken":"TOKEN"}'

import { Client } from 'pg';

function parseArgs(argv) {
  const args = { type: undefined, name: undefined, data: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') args.type = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--data') args.data = argv[++i];
  }
  return args;
}

function normalizeProperties(raw) {
  if (!raw) return undefined;
  if (Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) return raw;
  if (typeof raw === 'string') {
    let text = raw.trim();
    for (let i = 0; i < 2; i++) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'string') { text = parsed; continue; }
        return parsed;
      } catch {}
    }
  }
  return undefined;
}

async function main() {
  const { type, name, data } = parseArgs(process.argv);
  if (!type) throw new Error('--type is required');
  if (!name) throw new Error('--name is required');

  const dbUrl = process.env.DATABASE_URL;
  const apiUrl = process.env.N8N_API_URL;
  const apiKey = process.env.N8N_API_KEY;
  if (!dbUrl) throw new Error('DATABASE_URL is not set');
  if (!apiUrl) throw new Error('N8N_API_URL is not set');
  if (!apiKey) throw new Error('N8N_API_KEY is not set');

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const res = await client.query(
      `SELECT name, "displayName", properties FROM credentials WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [type]
    );
    if (res.rows.length === 0) throw new Error(`Credential type not found: ${type}`);

    const row = res.rows[0];
    let props = normalizeProperties(row.properties);
    if (!props) throw new Error('Cannot parse properties from DB');
    if (!Array.isArray(props)) throw new Error('Expected properties to be an array');

    // Collect defaults
    const defaults = {};
    for (const p of props) {
      if (p && Object.prototype.hasOwnProperty.call(p, 'default')) {
        defaults[p.name] = p.default;
      }
    }

    // Merge user data
    let userData = {};
    if (data) {
      try { userData = JSON.parse(data); } catch (e) { throw new Error(`Invalid --data JSON: ${e.message}`); }
    }

    // Build final data
    const payloadData = { ...defaults, ...userData };

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const body = {
      name: `${name} - ${timestamp}`,
      type: row.name,
      data: payloadData,
    };

    const resp = await fetch(`${apiUrl}/api/v1/credentials`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text}`);
    console.log(text);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});

