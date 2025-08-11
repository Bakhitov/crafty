import { Pool } from 'pg';
import { env } from '../config/environment';

const pool = new Pool({
  connectionString: env.database.url,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

export type MastraUserRow = {
  id: string;
  contact_id: string | null;
  name: string | null;
  role: string | null;
  is_active: boolean | null;
  type_agent: string | null;
  source: string | null;
  last_thread_id: string | null;
  n8n_url?: string | null;
  n8n_api_key?: string | null;
  created_at: string;
  update_at: string | null;
};

export const UserRegistrationService = {
  async findByContactId(contactId: string): Promise<MastraUserRow | null> {
    const client = await pool.connect();
    try {
      const res = await client.query(
        `select id, contact_id, name, role, is_active, type_agent, source, last_thread_id, n8n_url, n8n_api_key, created_at, update_at
         from public.mastra_users
         where contact_id = $1
         limit 1`,
        [contactId]
      );
      return res.rows[0] ?? null;
    } finally {
      client.release();
    }
  },

  async createInactiveUser(args: {
    contactId: string;
    name: string;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // id, created_at have defaults; ensure update_at set to now
      await client.query(
        `insert into public.mastra_users
          (contact_id, name, role, is_active, type_agent, source, update_at)
         values ($1, $2, 'member', false, 'n8n', 'telegram', now())
         on conflict do nothing`,
        [args.contactId, args.name]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async updateLlmModel(args: {
    contactId: string;
    provider: string;
    model: string;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `update public.mastra_users
         set provider_llm = $1,
             model_llm = $2,
             update_at = now()
         where contact_id = $3`,
        [args.provider, args.model, args.contactId]
      );
    } finally {
      client.release();
    }
  },

  async updateLlmApiKey(args: {
    contactId: string;
    apiKey: string | null;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `update public.mastra_users
         set api_key_llm = $1,
             update_at = now()
         where contact_id = $2`,
        [args.apiKey, args.contactId]
      );
    } finally {
      client.release();
    }
  },

  async updateN8nUrl(args: {
    contactId: string;
    n8nUrl: string | null;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `update public.mastra_users
         set n8n_url = $1,
             update_at = now()
         where contact_id = $2`,
        [args.n8nUrl, args.contactId]
      );
    } finally {
      client.release();
    }
  },

  async updateN8nApiKey(args: {
    contactId: string;
    apiKey: string | null;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `update public.mastra_users
         set n8n_api_key = $1,
             update_at = now()
         where contact_id = $2`,
        [args.apiKey, args.contactId]
      );
    } finally {
      client.release();
    }
  },

  async updateLastThreadId(args: {
    contactId: string;
    lastThreadId: string | null;
  }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `update public.mastra_users
         set last_thread_id = $1,
             update_at = now()
         where contact_id = $2`,
        [args.lastThreadId, args.contactId]
      );
    } finally {
      client.release();
    }
  },

  async setActive(args: { contactId: string; isActive: boolean }): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `update public.mastra_users
         set is_active = $1,
             update_at = now()
         where contact_id = $2`,
        [args.isActive, args.contactId]
      );
    } finally {
      client.release();
    }
  },
};

