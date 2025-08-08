// Выносим типы в отдельный файл для лучшей организации
export interface CredentialType {
  name: string;
  displayName: string;
  properties: Record<string, any>;
  documentationUrl?: string;
}

export interface N8nCredentialResponse {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  isManaged: boolean;
}

export interface FieldInfo {
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

export interface ConditionalField {
  field: FieldInfo;
  showWhen: {
    fieldName: string;
    values: any[];
  };
}

export interface ParsedFields {
  mainFields: FieldInfo[];
  conditionalFields: Record<string, ConditionalField[]>;
  hiddenFields: string[];
  totalFieldsFound: number;
}