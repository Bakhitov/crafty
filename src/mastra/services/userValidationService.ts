import { UserCacheService } from './userCache';
import { ValidationError, NotFoundError } from '../utils/errors';

export interface UserValidationResult {
  isValid: boolean;
  apiKey?: string;
  message?: string;
}

/**
 * Сервис для валидации пользователей Telegram
 */
export class UserValidationService {
  private static cacheService: UserCacheService | null = null;

  /**
   * Инициализация сервиса с экземпляром кэша
   * @param cacheService - Экземпляр UserCacheService
   */
  static init(cacheService: UserCacheService): void {
    this.cacheService = cacheService;
  }

  /**
   * Валидация пользователя по chatId
   * @param chatId - ID чата в Telegram
   * @returns Результат валидации с API ключом или сообщением об ошибке
   */
  static async validateUser(chatId: string): Promise<UserValidationResult> {
    if (!this.cacheService) {
      throw new ValidationError('UserValidationService not initialized. Call init() first.');
    }
    try {
      // Первая проверка в кэше
      let user = this.cacheService.getUserByContactId(chatId);
      
      if (user) {
        // Пользователь найден в кэше
        if (user.api_key) {
          return {
            isValid: true,
            apiKey: user.api_key,
            message: `Пользователь ${chatId} успешно авторизован`
          };
        } else {
          return {
            isValid: false,
            message: `У пользователя ${chatId} отсутствует API ключ`
          };
        }
      }

      // Пользователь не найден в кэше - обновляем кэш
      console.log(`User ${chatId} not found in cache, refreshing...`);
      await this.cacheService.forceRefresh();
      
      // Повторная проверка после обновления кэша
      user = this.cacheService.getUserByContactId(chatId);
      
      if (user) {
        // Пользователь найден после обновления
        if (user.api_key) {
          return {
            isValid: true,
            apiKey: user.api_key,
            message: `Пользователь ${chatId} найден после обновления кэша`
          };
        } else {
          return {
            isValid: false,
            message: `У пользователя ${chatId} отсутствует API ключ`
          };
        }
      }

      // Пользователь не найден даже после обновления кэша
      return {
        isValid: false,
        message: `Пользователь ${chatId} не найден или не активен`
      };

    } catch (error) {
      console.error('Error during user validation:', error);
      return {
        isValid: false,
        message: `Ошибка при валидации пользователя: ${error}`
      };
    }
  }

  /**
   * Проверяет, есть ли пользователь в кэше без обновления
   * @param chatId - ID чата в Telegram
   * @returns true если пользователь найден в кэше
   */
  static isUserInCache(chatId: string): boolean {
    if (!this.cacheService) {
      throw new ValidationError('UserValidationService not initialized. Call init() first.');
    }
    return this.cacheService.getUserByContactId(chatId) !== null;
  }

  /**
   * Получает API ключ пользователя из кэша
   * @param chatId - ID чата в Telegram
   * @returns API ключ или null
   */
  static getUserApiKey(chatId: string): string | null {
    if (!this.cacheService) {
      throw new ValidationError('UserValidationService not initialized. Call init() first.');
    }
    return this.cacheService.getUserApiKey(chatId);
  }

  /**
   * Получает статистику кэша для отладки
   */
  static getCacheStats() {
    if (!this.cacheService) {
      throw new ValidationError('UserValidationService not initialized. Call init() first.');
    }
    return this.cacheService.getCacheStats();
  }
}