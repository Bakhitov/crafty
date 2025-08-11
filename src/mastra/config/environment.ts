// Централизованная конфигурация окружения
import { z } from 'zod';

const environmentSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  
  // N8N Configuration
  N8N_API_URL: z.string().url().default('https://n8n.srv945365.hstgr.cloud'),
  N8N_API_KEY: z.string().optional(),
  
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  
  // Cache
  CACHE_REFRESH_INTERVAL_MS: z.coerce.number().default(180000), // 3 minutes
  
  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  // Public URL for Telegram WebApp (Mini App)
  APP_PUBLIC_URL: z.string().url().optional(),
  
  // Node Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

class EnvironmentConfig {
  private static instance: EnvironmentConfig;
  private config: z.infer<typeof environmentSchema>;

  private constructor() {
    try {
      this.config = environmentSchema.parse(process.env);
    } catch (error) {
      console.error('❌ Environment validation failed:', error);
      throw new Error('Invalid environment configuration');
    }
  }

  static getInstance(): EnvironmentConfig {
    if (!EnvironmentConfig.instance) {
      EnvironmentConfig.instance = new EnvironmentConfig();
    }
    return EnvironmentConfig.instance;
  }

  get database() {
    return {
      url: this.config.DATABASE_URL,
      cacheRefreshInterval: this.config.CACHE_REFRESH_INTERVAL_MS,
    };
  }

  get n8n() {
    return {
      apiUrl: this.config.N8N_API_URL,
      apiKey: this.config.N8N_API_KEY,
    };
  }

  get telegram() {
    return {
      botToken: this.config.TELEGRAM_BOT_TOKEN,
    };
  }

  get logging() {
    return {
      level: this.config.LOG_LEVEL,
    };
  }

  get app() {
    return {
      publicUrl: this.config.APP_PUBLIC_URL,
    };
  }

  get isDevelopment() {
    return this.config.NODE_ENV === 'development';
  }

  get isProduction() {
    return this.config.NODE_ENV === 'production';
  }
}

export const env = EnvironmentConfig.getInstance();