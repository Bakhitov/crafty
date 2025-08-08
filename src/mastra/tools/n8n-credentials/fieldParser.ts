import { FieldInfo, ParsedFields, ConditionalField, CredentialType } from './types';

// Выносим логику парсинга полей в отдельный модуль
export class CredentialFieldParser {
  private static readonly SKIP_FIELD_TYPES = new Set([
    'hidden',
    'notice', 
    'responseCode',
    'responseSuccessBody',
    'responseErrorBody',
    'httpStatusCode',
    'httpResponseBody'
  ]);

  private static readonly PASSWORD_FIELD_INDICATORS = [
    'password', 'secret', 'token', 'key', 'apikey', 'api_key',
    'accesstoken', 'access_token', 'secretkey', 'secret_key',
    'privatekey', 'private_key', 'credentials', 'auth'
  ];

  static parseCredentialFields(credentialType: CredentialType): ParsedFields {
    const mainFields: FieldInfo[] = [];
    const conditionalFields: Record<string, ConditionalField[]> = {};
    const hiddenFields: string[] = [];
    let totalFieldsFound = 0;

    if (!credentialType.properties) {
      return { mainFields, conditionalFields, hiddenFields, totalFieldsFound };
    }

    // Логика парсинга полей...
    for (const [fieldName, fieldConfig] of Object.entries(credentialType.properties)) {
      totalFieldsFound++;
      
      if (this.shouldSkipField(fieldConfig)) {
        hiddenFields.push(fieldName);
        continue;
      }

      const fieldInfo = this.createFieldInfo(fieldName, fieldConfig);
      
      if (this.isConditionalField(fieldConfig)) {
        const condition = this.extractCondition(fieldConfig);
        if (condition) {
          if (!conditionalFields[condition.fieldName]) {
            conditionalFields[condition.fieldName] = [];
          }
          conditionalFields[condition.fieldName].push({
            field: fieldInfo,
            showWhen: condition
          });
          continue;
        }
      }

      mainFields.push(fieldInfo);
    }

    return { mainFields, conditionalFields, hiddenFields, totalFieldsFound };
  }

  private static shouldSkipField(fieldConfig: any): boolean {
    return this.SKIP_FIELD_TYPES.has(fieldConfig.type);
  }

  private static createFieldInfo(fieldName: string, fieldConfig: any): FieldInfo {
    return {
      name: fieldName,
      displayName: fieldConfig.displayName || fieldName,
      description: fieldConfig.description || '',
      type: fieldConfig.type || 'string',
      required: fieldConfig.required || false,
      isPassword: this.isPasswordField(fieldName, fieldConfig),
      options: fieldConfig.options || [],
      placeholder: fieldConfig.placeholder,
      default: fieldConfig.default,
      validation: this.extractValidation(fieldConfig)
    };
  }

  private static isPasswordField(fieldName: string, fieldConfig: any): boolean {
    const lowerName = fieldName.toLowerCase();
    return this.PASSWORD_FIELD_INDICATORS.some(indicator => 
      lowerName.includes(indicator)
    ) || fieldConfig.typeOptions?.password;
  }

  private static isConditionalField(fieldConfig: any): boolean {
    return !!fieldConfig.displayOptions?.show;
  }

  private static extractCondition(fieldConfig: any) {
    const showConditions = fieldConfig.displayOptions?.show;
    if (!showConditions) return null;

    // Извлекаем первое условие (можно расширить для множественных условий)
    const firstKey = Object.keys(showConditions)[0];
    if (!firstKey) return null;

    return {
      fieldName: firstKey,
      values: Array.isArray(showConditions[firstKey]) 
        ? showConditions[firstKey] 
        : [showConditions[firstKey]]
    };
  }

  private static extractValidation(fieldConfig: any) {
    const validation: any = {};
    
    if (fieldConfig.typeOptions?.minValue !== undefined) {
      validation.minLength = fieldConfig.typeOptions.minValue;
    }
    
    if (fieldConfig.typeOptions?.maxValue !== undefined) {
      validation.maxLength = fieldConfig.typeOptions.maxValue;
    }

    return Object.keys(validation).length > 0 ? validation : undefined;
  }
}