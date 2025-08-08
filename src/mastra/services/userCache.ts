import { Pool, PoolClient } from 'pg';
import { z } from 'zod';

// Упрощенная схема - только нужные для кеша поля
const UserDataSchema = z.object({
  contact_id: z.string(),
  api_key: z.string().nullable(),
  is_active: z.boolean().default(true),
});

export type CachedUserData = z.infer<typeof UserDataSchema>;

interface CacheStats {
  totalActiveUsers: number;
  usersWithApiKey: number;
  lastRefresh: Date;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Сервис для кэширования пользовательских данных
 */
export class UserCacheService {
  private cache = new Map<string, CachedUserData>();
  private pool: Pool;
  private refreshInterval: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stats: CacheStats = {
    totalActiveUsers: 0,
    usersWithApiKey: 0,
    lastRefresh: new Date(),
    cacheHits: 0,
    cacheMisses: 0,
  };

  constructor(connectionString: string, refreshIntervalMs: number = 3600000) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    this.refreshInterval = refreshIntervalMs;
  }

  /**
   * Инициализация кэша - загрузка данных из БД и запуск планировщика
   */
  async initialize(): Promise<void> {
    try {
      await this.refreshCache();
      this.startRefreshScheduler();
      console.log(`UserCacheService initialized with ${this.cache.size} users`);
    } catch (error) {
      console.error('Failed to initialize UserCacheService:', error);
      throw error;
    }
  }

  /**
   * Получение данных пользователя из кэша по contact_id с метриками
   */
  getUserByContactId(contactId: string): CachedUserData | null {
    const user = this.cache.get(contactId);
    
    if (user) {
      this.stats.cacheHits++;
      return user;
    }
    
    this.stats.cacheMisses++;
    return null;
  }

  /**
   * Получение всех пользователей из кэша
   */
  getAllUsers(): CachedUserData[] {
    return Array.from(this.cache.values());
  }

  /**
   * Проверка активности пользователя
   */
  isUserActive(contactId: string): boolean {
    const user = this.cache.get(contactId);
    return user?.is_active === true;
  }

  /**
   * Получение API ключа пользователя по contact_id
   */
  getUserApiKey(contactId: string): string | null {
    const user = this.cache.get(contactId);
    return user?.api_key || null;
  }

  /**
   * Обновление кэша из базы данных с валидацией данных
   */
  private async refreshCache(): Promise<void> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const query = `
        SELECT contact_id, api_key, is_active
        FROM public.mastra_users 
        WHERE contact_id IS NOT NULL 
        AND is_active = true
        ORDER BY contact_id
      `;

      const result = await client.query(query);
      
      // Валидация данных из БД
      const validatedUsers: CachedUserData[] = [];
      for (const row of result.rows) {
        try {
          const userData = UserDataSchema.parse({
            contact_id: row.contact_id,
            api_key: row.api_key,
            is_active: row.is_active,
          });
          validatedUsers.push(userData);
        } catch (validationError) {
          console.warn(`⚠️ Invalid user data for contact_id ${row.contact_id}:`, validationError);
        }
      }

      // Атомарное обновление кэша
      this.cache.clear();
      validatedUsers.forEach(user => {
        this.cache.set(user.contact_id, user);
      });

      // Обновление статистики
      this.updateStats();
      
      await client.query('COMMIT');
      console.log(`🔄 Cache refreshed: ${validatedUsers.length} active users loaded`);
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error refreshing cache:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Запуск планировщика для обновления кэша
   */
  private startRefreshScheduler(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      try {
        console.log('Starting scheduled cache refresh...');
        await this.refreshCache();
      } catch (error) {
        console.error('Scheduled cache refresh failed:', error);
      }
    }, this.refreshInterval);

    console.log(`Cache refresh scheduler started (interval: ${this.refreshInterval}ms)`);
  }

  /**
   * Остановка планировщика
   */
  stopRefreshScheduler(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      console.log('Cache refresh scheduler stopped');
    }
  }

  /**
   * Принудительное обновление кэша
   */
  async forceRefresh(): Promise<void> {
    await this.refreshCache();
  }

  /**
   * Получение расширенной статистики кэша
   */
  getCacheStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Обновление внутренней статистики
   */
  private updateStats(): void {
    const users = Array.from(this.cache.values());
    this.stats.totalActiveUsers = users.length;
    this.stats.usersWithApiKey = users.filter(u => u.api_key).length;
    this.stats.lastRefresh = new Date();
  }

  /**
   * Health check для мониторинга
   */
  async healthCheck(): Promise<{ status: string; details: CacheStats }> {
    try {
      // Проверяем соединение с БД
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      return {
        status: 'healthy',
        details: this.getCacheStats(),
      };
    } catch (error) {
      console.error('Health check failed:', error);
      return {
        status: 'unhealthy',
        details: this.getCacheStats(),
      };
    }
  }

  /**
   * Закрытие соединений и очистка ресурсов
   */
  async shutdown(): Promise<void> {
    this.stopRefreshScheduler();
    await this.pool.end();
    this.cache.clear();
    console.log('UserCacheService shut down');
  }
}