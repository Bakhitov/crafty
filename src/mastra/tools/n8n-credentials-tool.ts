import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Client } from 'pg';

// ===============================
// 🏗️ ТИПЫ И ИНТЕРФЕЙСЫ
// ===============================

interface CredentialType {
  name: string;
  displayName: string;
  properties: Record<string, any>;
  documentationUrl?: string;
}

interface N8nCredentialResponse {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  isManaged: boolean;
}

interface FieldInfo {
  name: string;
  displayName: string;
  description: string;
  type: string;
  required: boolean;
  isPassword: boolean;
  options: Array<{ name: string; value: any; description?: string }>;
  placeholder?: string;
  default?: any;
  validation?: {
    pattern?: string;
    minLength?: number;
    maxLength?: number;
  };
}

interface ConditionalField {
  field: FieldInfo;
  showWhen: {
    fieldName: string;
    values: any[];
  };
}

interface ParsedFields {
  mainFields: FieldInfo[];
  conditionalFields: Record<string, ConditionalField[]>;
  hiddenFields: string[];
  totalFieldsFound: number;
}

// ===============================
// 🔧 КОНФИГУРАЦИЯ
// ===============================

// Системные поля которые нужно пропускать
const SKIP_FIELD_TYPES = new Set([
  'hidden',
  'notice', 
  'responseCode',
  'responseSuccessBody',
  'responseErrorBody',
  'httpStatusCode',
  'httpResponseBody'
]);

// Поля которые содержат пароли/секреты
const PASSWORD_FIELD_INDICATORS = [
  'password', 'secret', 'token', 'key', 'apikey', 'api_key',
  'accesstoken', 'access_token', 'secretkey', 'secret_key',
  'privatekey', 'private_key', 'credentials', 'auth'
];

// ===============================
// 🎯 ОСНОВНОЙ ИНСТРУМЕНТ
// ===============================

export const n8nCredentialsTool = createTool({
  id: 'create-n8n-credentials',
  description: `
Creates credentials in n8n by searching credential types and requesting required authentication data with advanced field parsing and validation.
  `,
  inputSchema: z.object({
    search_term: z.string().describe('Search term to find credential type (e.g., "telegram", "aws", "slack")'),
    credential_name: z.string().optional().describe('Display name for the new credential'),
    credential_data: z.record(z.any()).optional().describe('Object with credential fields using exact field names as keys. Example: {"accessToken": "your_token", "baseUrl": "https://api.telegram.org"}'),
    
    selected_api_type: z.string().optional().describe('Specific API type name when multiple found'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    credential_id: z.string().optional(),
    message: z.string(),
    required_fields: z.array(z.string()).optional(),
  }),
  execute: async ({ context }) => {
    return await createN8nCredentials(
      context.search_term,
      context.credential_name,
      context.credential_data,
      context.selected_api_type
    );
  },
});

// ===============================
// 🧠 ГЛАВНАЯ ЛОГИКА
// ===============================

const createN8nCredentials = async (
  searchTerm: string,
  credentialName?: string,
  credentialData?: Record<string, any>,
  selectedApiType?: string
): Promise<{
  success: boolean;
  credential_id?: string;
  message: string;
  required_fields?: string[];
}> => {
  const connectionString = process.env.DATABASE_URL || 'postgresql://user:pass@host:5432/dbname';
  const client = new Client({ connectionString });

  try {
    await client.connect();

    // 1. Поиск API в базе данных (поэтапный поиск по алгоритму)
    let searchResult;
    
    // Шаг 1: Точный поиск по name
    let searchQuery = `
      SELECT name, "displayName", properties
      FROM credentials
      WHERE LOWER(name) = LOWER($1)
      LIMIT 1
    `;
    searchResult = await client.query(searchQuery, [searchTerm]);
    
    // Шаг 2: Если не найдено - частичный поиск по displayName  
    if (searchResult.rows.length === 0) {
      searchQuery = `
        SELECT name, "displayName", properties
        FROM credentials
        WHERE LOWER("displayName") LIKE LOWER($1)
        LIMIT 5
      `;
      searchResult = await client.query(searchQuery, [`%${searchTerm}%`]);
    }
    
    // Шаг 3: Если не найдено - поиск по documentationUrl
    if (searchResult.rows.length === 0) {
      searchQuery = `
        SELECT name, "displayName", properties
        FROM credentials
        WHERE LOWER("documentationUrl") LIKE LOWER($1)
        LIMIT 5
      `;
      searchResult = await client.query(searchQuery, [`%${searchTerm}%`]);
    }
    
    if (searchResult.rows.length === 0) {
      return {
        success: false,
        message: `No credential types found for search term: "${searchTerm}". Please try a different search term.`,
      };
    }

    const foundTypes: CredentialType[] = searchResult.rows.map(row => ({
      name: row.name,
      displayName: row.displayName,
      properties: row.properties
    }));

    // Если множественные результаты и не указан конкретный тип
    if (foundTypes.length > 1 && !selectedApiType) {
      const typeNames = foundTypes.map(t => `${t.displayName} (${t.name})`).join(', ');
      return {
        success: false,
        message: `Found ${foundTypes.length} credential types: ${typeNames}. Please specify selected_api_type with exact API name.`,
      };
    }

    // Выбираем API тип
    let selectedType: CredentialType;
    if (selectedApiType) {
      const found = foundTypes.find(t => t.name === selectedApiType);
      if (!found) {
        return {
          success: false,
          message: `API type "${selectedApiType}" not found among search results.`,
        };
      }
      selectedType = found;
    } else {
      selectedType = foundTypes[0];
    }
    
    // 2. Продвинутый парсинг полей
    const parsedFields = parseCredentialFields(selectedType.properties, false);
    const requiredFields = parsedFields.mainFields.filter(f => f.required);
    const allValidFields = parsedFields.mainFields.map(f => f.name);
    
    // Если нет данных для создания - возвращаем детальную информацию о полях
    if (!credentialData) {
      let message = `Found credential type "${selectedType.displayName}" (${selectedType.name}).`;
      
      if (parsedFields.totalFieldsFound > parsedFields.mainFields.length) {
        message += `\n📊 Total fields found: ${parsedFields.totalFieldsFound} (${parsedFields.hiddenFields.length} system fields filtered out)`;
      }
      
      if (requiredFields.length > 0) {
        message += `\n\n🔴 REQUIRED fields:`;
        requiredFields.forEach(field => {
          message += `\n  • **${field.displayName}** (\`${field.name}\`)${field.isPassword ? ' 🔒' : ''}`;
          if (field.description) {
            message += `\n    ${field.description}`;
          }
          if (field.options.length > 0) {
            message += `\n    Options: ${field.options.map(opt => `"${opt.name}"`).join(', ')}`;
          }
          if (field.placeholder) {
            message += `\n    Example: \`${field.placeholder}\``;
          }
        });
      }
      
      const optionalFields = parsedFields.mainFields.filter(f => !f.required);
      if (optionalFields.length > 0) {
        message += `\n\n🔵 OPTIONAL fields:`;
        optionalFields.forEach(field => {
          message += `\n  • **${field.displayName}** (\`${field.name}\`)${field.isPassword ? ' 🔒' : ''}`;
          if (field.description) {
            message += `\n    ${field.description}`;
          }
        });
      }
      
      // Показываем условные поля если есть
      if (Object.keys(parsedFields.conditionalFields).length > 0) {
        message += `\n\n🔄 CONDITIONAL fields:`;
        for (const [triggerField, conditionals] of Object.entries(parsedFields.conditionalFields)) {
          message += `\n  When \`${triggerField}\` is set:`;
          conditionals.forEach(cond => {
            message += `\n    • **${cond.field.displayName}** appears when value is: ${cond.showWhen.values.map(v => `"${v}"`).join(', ')}`;
          });
        }
      }
      
      message += `\n\n📝 EXAMPLE USAGE:`;
      message += `\nCall this tool again with credential_name and credential_data like this:`;
      message += `\n\`\`\`json`;
      message += `\n{`;
      message += `\n  "credential_name": "My ${selectedType.displayName}",`;
      message += `\n  "credential_data": {`;
      
      // Показываем ВСЕ поля - и обязательные, и опциональные
      const allFields = parsedFields.mainFields;
      allFields.forEach((field, index) => {
        let exampleValue;
        
        // Используем default значение если есть
        if (field.default !== undefined && field.default !== null && field.default !== '') {
          exampleValue = typeof field.default === 'string' ? `"${field.default}"` : JSON.stringify(field.default);
        } else if (field.isPassword) {
          exampleValue = '"your_secret_here"';
        } else if (field.placeholder) {
          exampleValue = `"${field.placeholder}"`;
        } else if (field.options.length > 0) {
          exampleValue = `"${field.options[0].value}"`;
        } else if (field.type === 'boolean') {
          exampleValue = 'true';
        } else {
          exampleValue = '"your_value_here"';
        }
        
        const comment = field.required ? ' // required' : field.default !== undefined ? ' // optional with default' : ' // optional';
        message += `\n    "${field.name}": ${exampleValue}${index < allFields.length - 1 ? ',' : ''}${comment}`;
      });
      
      message += `\n  }`;
      message += `\n}`;
      message += `\n\`\`\``;
      message += `\n\n⚠️ Use exact field names as shown above!\n💡 Optional fields with defaults will be auto-filled if not provided.`;
      
      return {
        success: false,
        message,
        required_fields: requiredFields.map(f => f.name),
      };
    }

    // 3. Проверка структуры credential_data
    const structureValidation = validateDataStructure(credentialData);
    if (!structureValidation.isValid) {
      return {
        success: false,
        message: `❌ Invalid credential_data structure: ${structureValidation.error}\n\n💡 Expected format: {"fieldName": "value", "anotherField": "value"}`,
        required_fields: requiredFields.map(f => f.name),
      };
    }

    // 4. Автоматическое заполнение default значений
    const enrichedCredentialData = fillDefaultValues(credentialData, parsedFields);
    
    // 5. Продвинутая валидация данных
    const validationResult = validateCredentialData(enrichedCredentialData, parsedFields);
    
    if (!validationResult.isValid) {
      let errorMessage = `❌ Validation errors found:\n`;
      validationResult.errors.forEach((error, index) => {
        errorMessage += `${index + 1}. ${error}\n`;
      });
      
      if (validationResult.warnings.length > 0) {
        errorMessage += `\n⚠️ Warnings:\n`;
        validationResult.warnings.forEach((warning, index) => {
          errorMessage += `${index + 1}. ${warning}\n`;
        });
      }
      
      return {
        success: false,
        message: errorMessage,
        required_fields: requiredFields.map(f => f.name),
      };
    }

    // 4. Создание credentials в n8n
    if (!credentialName) {
      return {
        success: false,
        message: `credential_name is required to create credentials.`,
      };
    }

    const n8nResult = await createCredentialsInN8n(
      credentialName,
      selectedType.name,
      enrichedCredentialData
    );

    if (n8nResult.success) {
      const providedFields = Object.keys(credentialData);
      const finalFields = Object.keys(enrichedCredentialData);
      const autoFilledFields = finalFields.filter(field => !providedFields.includes(field));
      
      let fieldsInfo = `• User provided: ${providedFields.join(', ')}`;
      if (autoFilledFields.length > 0) {
        fieldsInfo += `\n• Auto-filled defaults: ${autoFilledFields.join(', ')}`;
      }
      
      return {
        success: true,
        credential_id: n8nResult.credential_id,
        message: `✅ Successfully created "${credentialName}" credentials for ${selectedType.displayName}. 

📋 Credential Details:
• ID: ${n8nResult.credential_id}
• Name: ${credentialName}
• Type: ${selectedType.name}
${fieldsInfo}
• Created: ${new Date().toISOString()}

🚀 You can now use these credentials in your n8n workflows by ID: ${n8nResult.credential_id}`,
      };
    } else {
      return {
        success: false,
        message: `❌ Failed to create credentials: ${n8nResult.message}`,
      };
    }

  } catch (error) {
    console.error('Error in createN8nCredentials:', error);
    
    let errorMessage = 'Unknown error occurred';
    if (error instanceof Error) {
      errorMessage = error.message;
      
      if (error.message.includes('connect') || error.message.includes('ECONNREFUSED')) {
        errorMessage = `Database connection failed: ${error.message}. Check DATABASE_URL environment variable.`;
      } else if (error.message.includes('relation') || error.message.includes('table')) {
        errorMessage = `Database table issue: ${error.message}. Check if 'credentials' table exists.`;
      } else if (error.message.includes('fetch') || error.message.includes('HTTP')) {
        errorMessage = `n8n API error: ${error.message}. Check n8n server and API key.`;
      }
    }
    
    return {
      success: false,
      message: `❌ Error creating credentials: ${errorMessage}`,
    };
  } finally {
    try {
      await client.end();
    } catch (closeError) {
      console.warn('Warning: Could not close database connection:', closeError);
    }
  }
};

// ===============================
// 🔧 ПАРСИНГ ПОЛЕЙ
// ===============================

const parseCredentialFields = (
  properties: any[] | Record<string, any>,
  includeSystemFields: boolean = false
): ParsedFields => {
  const mainFields: FieldInfo[] = [];
  const conditionalFields: Record<string, ConditionalField[]> = {};
  const hiddenFields: string[] = [];
  let totalFieldsFound = 0;

  if (!properties) {
    return {
      mainFields: [],
      conditionalFields: {},
      hiddenFields: [],
      totalFieldsFound: 0,
    };
  }

  // Обрабатываем массив properties из БД
  const propertiesArray = Array.isArray(properties) ? properties : Object.values(properties);
  
  for (const fieldConfig of propertiesArray) {
    if (!fieldConfig || typeof fieldConfig !== 'object' || !fieldConfig.name) continue;
    
    totalFieldsFound++;

    // 🚫 ФИЛЬТРАЦИЯ СИСТЕМНЫХ ПОЛЕЙ
    if (!includeSystemFields && SKIP_FIELD_TYPES.has(fieldConfig.type)) {
      hiddenFields.push(fieldConfig.name);
      continue;
    }

    // 🏗️ БАЗОВАЯ ИНФОРМАЦИЯ О ПОЛЕ
    const fieldInfo: FieldInfo = {
      name: fieldConfig.name,
      displayName: fieldConfig.displayName || fieldConfig.name,
      description: combineFieldHints(fieldConfig),
      type: fieldConfig.type || 'string',
      required: determineIfRequired(fieldConfig),
      isPassword: isPasswordField(fieldConfig.name, fieldConfig),
      options: extractFieldOptions(fieldConfig),
      placeholder: fieldConfig.placeholder,
      default: fieldConfig.default,
      validation: extractValidationRules(fieldConfig),
    };

    // 🔄 ОБРАБОТКА УСЛОВНЫХ ПОЛЕЙ
    if (fieldConfig.displayOptions && fieldConfig.displayOptions.show) {
      const showConditions = fieldConfig.displayOptions.show;
      
      for (const [conditionField, conditionValues] of Object.entries(showConditions)) {
        if (!conditionalFields[conditionField]) {
          conditionalFields[conditionField] = [];
        }
        
        conditionalFields[conditionField].push({
          field: fieldInfo,
          showWhen: {
            fieldName: conditionField,
            values: Array.isArray(conditionValues) ? conditionValues : [conditionValues],
          },
        });
      }
    } else {
      // Обычное поле
      mainFields.push(fieldInfo);
    }
  }

  // Сортировка полей: обязательные первыми
  mainFields.sort((a, b) => {
    if (a.required && !b.required) return -1;
    if (!a.required && b.required) return 1;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    mainFields,
    conditionalFields,
    hiddenFields,
    totalFieldsFound,
  };
};

// ===============================
// 🔧 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ПАРСИНГА
// ===============================

const combineFieldHints = (fieldConfig: any): string => {
  const hints: string[] = [];
  
  if (fieldConfig.description) {
    hints.push(fieldConfig.description);
  }
  
  if (fieldConfig.placeholder) {
    hints.push(`Пример: ${fieldConfig.placeholder}`);
  }
  
  if (fieldConfig.hint) {
    hints.push(fieldConfig.hint);
  }
  
  return hints.join(' | ');
};

const determineIfRequired = (fieldConfig: any): boolean => {
  // Явно указано required
  if (fieldConfig.required === true) return true;
  if (fieldConfig.required === false) return false;
  
  // Если есть default значение и оно НЕ пустая строка, считаем опциональным  
  if (fieldConfig.default !== undefined && fieldConfig.default !== null && fieldConfig.default !== '') {
    return false;
  }
  
  // Если нет default значения или default = "", считаем обязательным
  return true;
};

const isPasswordField = (fieldName: string, fieldConfig: any): boolean => {
  // Проверяем typeOptions.password
  if (fieldConfig.typeOptions && fieldConfig.typeOptions.password === true) {
    return true;
  }
  
  // Проверяем имя поля на ключевые слова
  const lowerName = fieldName.toLowerCase();
  return PASSWORD_FIELD_INDICATORS.some(indicator => 
    lowerName.includes(indicator)
  );
};

const extractFieldOptions = (fieldConfig: any): Array<{ name: string; value: any; description?: string }> => {
  if (!fieldConfig.options || !Array.isArray(fieldConfig.options)) {
    return [];
  }
  
  return fieldConfig.options.map((option: any) => {
    if (typeof option === 'string') {
      return { name: option, value: option };
    }
    
    if (typeof option === 'object' && option !== null) {
      return {
        name: option.name || option.label || String(option.value),
        value: option.value,
        description: option.description,
      };
    }
    
    return { name: String(option), value: option };
  });
};

const extractValidationRules = (fieldConfig: any): FieldInfo['validation'] => {
  const validation: FieldInfo['validation'] = {};
  
  if (fieldConfig.pattern) {
    validation.pattern = fieldConfig.pattern;
  }
  
  if (fieldConfig.minLength !== undefined) {
    validation.minLength = fieldConfig.minLength;
  }
  
  if (fieldConfig.maxLength !== undefined) {
    validation.maxLength = fieldConfig.maxLength;
  }
  
  return Object.keys(validation).length > 0 ? validation : undefined;
};

// ===============================
// ✅ ВАЛИДАЦИЯ
// ===============================

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

const validateCredentialData = (
  credentialData: Record<string, any>,
  parsedFields: ParsedFields
): ValidationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  const allFields = parsedFields.mainFields;
  const providedFields = Object.keys(credentialData);
  const allValidFieldNames = allFields.map(f => f.name);
  
  // 1️⃣ ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ
  const requiredFields = allFields.filter(f => f.required);
  const missingRequired = requiredFields.filter(field => 
    credentialData[field.name] === undefined || 
    credentialData[field.name] === null ||
    credentialData[field.name] === ''
  );
  
  if (missingRequired.length > 0) {
    errors.push(`Missing required fields: ${missingRequired.map(f => f.displayName).join(', ')}`);
  }
  
  // 2️⃣ ПРОВЕРКА НЕДОПУСТИМЫХ ПОЛЕЙ
  const invalidFields = providedFields.filter(fieldName => 
    !allValidFieldNames.includes(fieldName)
  );
  
  if (invalidFields.length > 0) {
    errors.push(`Invalid fields provided: ${invalidFields.join(', ')}. Valid fields are: ${allValidFieldNames.join(', ')}`);
  }
  
  // 3️⃣ ВАЛИДАЦИЯ ЗНАЧЕНИЙ ПОЛЕЙ
  for (const field of allFields) {
    const value = credentialData[field.name];
    
    if (value === undefined || value === null) continue;
    
    // Проверка паттерна
    if (field.validation?.pattern && typeof value === 'string') {
      try {
        const regex = new RegExp(field.validation.pattern);
        if (!regex.test(value)) {
          errors.push(`Field "${field.displayName}" does not match required format`);
        }
      } catch (e) {
        warnings.push(`Cannot validate pattern for field "${field.displayName}"`);
      }
    }
    
    // Проверка длины для строк
    if (typeof value === 'string') {
      if (field.validation?.minLength && value.length < field.validation.minLength) {
        errors.push(`Field "${field.displayName}" is too short (minimum ${field.validation.minLength} characters)`);
      }
      
      if (field.validation?.maxLength && value.length > field.validation.maxLength) {
        errors.push(`Field "${field.displayName}" is too long (maximum ${field.validation.maxLength} characters)`);
      }
    }
    
    // Проверка options
    if (field.options.length > 0) {
      const validValues = field.options.map(opt => opt.value);
      if (!validValues.includes(value)) {
        errors.push(`Field "${field.displayName}" must be one of: ${field.options.map(opt => opt.name).join(', ')}`);
      }
    }
  }
  
  // 4️⃣ ПРОВЕРКА УСЛОВНЫХ ПОЛЕЙ
  for (const [triggerField, conditionalFieldsList] of Object.entries(parsedFields.conditionalFields)) {
    const triggerValue = credentialData[triggerField];
    
    for (const conditional of conditionalFieldsList) {
      const shouldShow = conditional.showWhen.values.includes(triggerValue);
      const fieldValue = credentialData[conditional.field.name];
      
      if (shouldShow && conditional.field.required && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
        errors.push(`When "${triggerField}" is "${triggerValue}", field "${conditional.field.displayName}" is required`);
      }
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
};

// Простая версия для обратной совместимости
const extractFieldsInfo = (properties: Record<string, any>): FieldInfo[] => {
  const parsed = parseCredentialFields(properties, false);
  return parsed.mainFields;
};

// ===============================
// 🔧 ЗАПОЛНЕНИЕ DEFAULT ЗНАЧЕНИЙ  
// ===============================

const fillDefaultValues = (
  credentialData: Record<string, any>,
  parsedFields: ParsedFields
): Record<string, any> => {
  const enrichedData = { ...credentialData };
  
  // Заполняем default значения для полей которые не были переданы
  for (const field of parsedFields.mainFields) {
    // Если поле не передано пользователем, но есть default значение
    if (enrichedData[field.name] === undefined && field.default !== undefined) {
      enrichedData[field.name] = field.default;
    }
  }
  
  return enrichedData;
};

// ===============================
// 🔍 ВАЛИДАЦИЯ СТРУКТУРЫ ДАННЫХ
// ===============================

interface StructureValidationResult {
  isValid: boolean;
  error?: string;
}

const validateDataStructure = (credentialData: Record<string, any>): StructureValidationResult => {
  // Проверка на массив вместо объекта
  if (Array.isArray(credentialData)) {
    return {
      isValid: false,
      error: 'credential_data must be an object, not an array'
    };
  }

  // Проверка на числовые ключи (частая ошибка агентов)
  const keys = Object.keys(credentialData);
  const hasNumericKeys = keys.some(key => !isNaN(Number(key)));
  
  if (hasNumericKeys) {
    return {
      isValid: false,
      error: `Found numeric keys: [${keys.filter(k => !isNaN(Number(k))).join(', ')}]. Use field names like "accessToken", not numbers.`
    };
  }

  // Проверка на пустые ключи
  const hasEmptyKeys = keys.some(key => key.trim() === '');
  if (hasEmptyKeys) {
    return {
      isValid: false,
      error: 'Found empty field names. All keys must be valid field names.'
    };
  }

  return { isValid: true };
};

// ===============================
// 🌐 СОЗДАНИЕ CREDENTIALS В N8N
// ===============================

const createCredentialsInN8n = async (
  name: string,
  type: string,
  data: Record<string, any>
): Promise<{
  success: boolean;
  credential_id?: string;
  message: string;
}> => {
  const apiUrl = process.env.N8N_BASE_URL || 'https://n8n.srv945365.hstgr.cloud';
  const apiKey = process.env.N8N_API_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZDEwMDNhYS0yNWM1LTQ3YTYtOTNhYy01NjNkM2Y2NWE5M2UiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzU0NDg0NDgwLCJleHAiOjE5MDMyMDEyMDB9.O_zo3cvkA3bVKjr7hynM7vpORiFH9D-4pZbWe0eWfKA';
  
  console.log('🔑 N8N API Key status:', {
    hasEnvKey: !!process.env.N8N_API_KEY,
    keyLength: apiKey?.length || 0,
    keyPreview: apiKey ? `${apiKey.substring(0, 20)}...` : 'undefined'
  });
  
  if (!apiKey || apiKey.trim() === '') {
    return {
      success: false,
      message: `N8N_API_KEY environment variable is required. Current value: ${process.env.N8N_API_KEY ? 'exists but empty' : 'not set'}`
    };
  }

  try {
    // Создаем уникальное имя с timestamp по алгоритму
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const uniqueName = `${name} - ${timestamp}`;
    
    const requestBody = {
      name: uniqueName,
      type,
      data
    };

    const response = await fetch(`${apiUrl}/api/v1/credentials`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result: N8nCredentialResponse = await response.json();

    return {
      success: true,
      credential_id: result.id,
      message: `Credentials "${uniqueName}" successfully created with ID: ${result.id}`,
    };

  } catch (error) {
    console.error('❌ N8N API error:', error);
    
    return {
      success: false,
      message: `Ошибка создания credentials: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
    };
  }
};

