// Централизованная система обработки ошибок
export class MastraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, any>
  ) {
    super(message);
    this.name = 'MastraError';
  }
}

export class ValidationError extends MastraError {
  constructor(message: string, details?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends MastraError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class NotFoundError extends MastraError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ExternalServiceError extends MastraError {
  constructor(service: string, originalError?: Error) {
    super(
      `External service error: ${service}`,
      'EXTERNAL_SERVICE_ERROR',
      502,
      { originalError: originalError?.message }
    );
    this.name = 'ExternalServiceError';
  }
}

// Типизированный результат с обработкой ошибок
export type Result<T, E = MastraError> = 
  | { success: true; data: T }
  | { success: false; error: E };

export function success<T>(data: T): Result<T> {
  return { success: true, data };
}

export function failure<E extends MastraError>(error: E): Result<never, E> {
  return { success: false, error };
}

// Утилита для безопасного выполнения async операций
export async function safeAsync<T>(
  operation: () => Promise<T>,
  errorContext?: string
): Promise<Result<T>> {
  try {
    const data = await operation();
    return success(data);
  } catch (error) {
    const mastraError = error instanceof MastraError 
      ? error 
      : new MastraError(
          errorContext ? `${errorContext}: ${error}` : String(error),
          'UNKNOWN_ERROR'
        );
    return failure(mastraError);
  }
}