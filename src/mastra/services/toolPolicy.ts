import fs from 'node:fs';
import path from 'node:path';

export type AgentRole = 'orchestrator' | 'architect' | 'builder' | 'qa' | 'deployer';

type RolePolicy = {
  allow?: string[]; // regex strings
  deny?: string[];  // regex strings
};

type ToolPolicyConfig = {
  ttlMs?: number;
  roles: Record<AgentRole, RolePolicy>;
};

const DEFAULT_POLICY: ToolPolicyConfig = {
  ttlMs: 10 * 60 * 1000,
  roles: {
    // Оркестратор видит все, чтобы упростить диагностику и маршрутизацию
    orchestrator: { allow: [".*"], deny: [] },
    // Архитектор: discovery/templates/essentials/минимальная валидация
    architect: {
      allow: [
        // Документация и справка
        "^(tools_documentation)$",
        // Шаблоны и прецепты
        "^(get_templates_for_task|search_templates|list_node_templates|get_template|list_tasks|get_node_for_task)$",
        // Дискавери узлов
        "^(search_nodes|list_nodes|list_ai_tools|get_database_statistics)$",
        // Конфигурационная информация
        "^(get_node_essentials|get_node_info|search_node_properties|get_property_dependencies|get_node_documentation|get_node_as_tool_info)$",
        // Базовая валидация конфигов
        "^(validate_node_minimal|validate_node_operation)$",
      ],
      deny: [],
    },
    // Билдер: конфигурация, полная валидация, работа с кредами (через Mastra tool)
    builder: {
      allow: [
        "^(tools_documentation)$",
        "^(search_nodes|list_nodes|list_ai_tools|get_database_statistics)$",
        "^(get_node_as_tool_info|get_node_essentials|get_node_info|search_node_properties|get_property_dependencies|get_node_documentation)$",
        "^(get_templates_for_task|search_templates|list_node_templates|get_template|get_node_for_task)$",
        // Полный набор валидаторов
        "^(validate_node_minimal|validate_node_operation|validate_workflow|validate_workflow_connections|validate_workflow_expressions)$",
        // Управление кредами из Mastra
        "^(n8n-credentials-crud)$",
      ],
      // Явно не даём доступ к деплою напрямую
      deny: [
        "^(n8n_create_workflow|n8n_update_full_workflow|n8n_update_partial_workflow|n8n_validate_workflow|n8n_trigger_webhook_workflow|n8n_health_check|n8n_list_workflows|n8n_get_workflow|n8n_get_workflow_details|n8n_get_workflow_structure|n8n_get_workflow_minimal|n8n_list_executions|n8n_get_execution|n8n_delete_execution|n8n_delete_workflow|n8n_list_available_tools|n8n_diagnostic|activate-n8n-workflow)$",
      ],
    },
    // QA: валидация и чтение статусов/исполнений, минимальные фикс‑операции через partial update
    qa: {
      allow: [
        "^(tools_documentation)$",
        "^(get_node_essentials|search_node_properties)$",
        "^(validate_node_minimal|validate_node_operation|validate_workflow|validate_workflow_connections|validate_workflow_expressions)$",
        // Доступ к инфо о воркфлоу и исполнениям
        "^(n8n_get_workflow|n8n_get_workflow_details|n8n_get_workflow_structure|n8n_get_workflow_minimal|n8n_list_executions|n8n_get_execution|n8n_validate_workflow)$",
        // Точечные правки как предложение
        "^(n8n_update_partial_workflow)$",
        // Шаблоны для сравнений
        "^(search_templates|get_node_for_task)$",
        // Возможность создать недостающие креды
        "^(n8n-credentials-crud)$",
      ],
      deny: [
        "^(n8n_create_workflow|n8n_update_full_workflow|n8n_trigger_webhook_workflow|activate-n8n-workflow)$",
      ],
    },
    // Деплойер: управление через n8n_* и активация
    deployer: {
      allow: [
        "^(tools_documentation)$",
        "^(validate_workflow)$",
        "^(n8n_health_check|n8n_create_workflow|n8n_update_partial_workflow|n8n_validate_workflow|n8n_trigger_webhook_workflow)$",
        "^(n8n_get_workflow|n8n_list_workflows|n8n_delete_workflow|n8n_update_full_workflow)$",
        "^(n8n_list_executions|n8n_get_execution|n8n_delete_execution)$",
        "^(n8n_list_available_tools|n8n_diagnostic)$",
        // Mastra tool для активации
        "^(activate-n8n-workflow)$",
      ],
      deny: [],
    },
  },
};

let cachedConfig: ToolPolicyConfig | null = null;
let lastLoadedAt = 0;

function loadFromEnv(): ToolPolicyConfig | null {
  try {
    // Support both JSON string and base64 JSON
    const raw = process.env.TOOL_POLICY_JSON;
    if (!raw) return null;
    const decoded = (() => {
      try { return Buffer.from(raw, 'base64').toString('utf8'); } catch { return raw; }
    })();
    const parsed = JSON.parse(decoded);
    return parsed as ToolPolicyConfig;
  } catch {
    return null;
  }
}

function loadFromFile(): ToolPolicyConfig | null {
  try {
    const candidate = path.resolve(process.cwd(), 'tool-policy.json');
    if (!fs.existsSync(candidate)) return null;
    const raw = fs.readFileSync(candidate, 'utf8');
    return JSON.parse(raw) as ToolPolicyConfig;
  } catch {
    return null;
  }
}

export function getToolPolicyConfig(): ToolPolicyConfig {
  const now = Date.now();
  if (cachedConfig && now - lastLoadedAt < (cachedConfig.ttlMs || DEFAULT_POLICY.ttlMs!)) {
    return cachedConfig;
  }
  const envCfg = loadFromEnv();
  const fileCfg = loadFromFile();
  cachedConfig = { ...DEFAULT_POLICY, ...(fileCfg || {}), ...(envCfg || {}) } as ToolPolicyConfig;
  lastLoadedAt = now;
  return cachedConfig;
}

export function filterToolsByRole(role: AgentRole, tools: Record<string, any>): Record<string, any> {
  // Global bypass: by default show ALL tools unless explicitly set to strict
  const policyMode = (process.env.TOOL_POLICY_MODE || '').toLowerCase();
  if (policyMode !== 'strict') {
    return tools;
  }
  const cfg = getToolPolicyConfig();
  const roleCfg = cfg.roles[role] || { allow: [".*"], deny: [] };
  const allowRegexes = (roleCfg.allow || [".*"]).map((r) => new RegExp(r));
  const denyRegexes = (roleCfg.deny || []).map((r) => new RegExp(r));

  const out: Record<string, any> = {};
  for (const [toolId, def] of Object.entries(tools)) {
    const allowed = allowRegexes.some((re) => re.test(toolId));
    const denied = denyRegexes.some((re) => re.test(toolId));
    if (allowed && !denied) out[toolId] = def;
  }
  // Safety: if nothing matched, fallback to a minimal safe subset to avoid exposing all tools
  if (Object.keys(out).length === 0 && role !== 'orchestrator') {
    // Minimal safe defaults by role (exact names)
    const MINIMAL: Record<AgentRole, string[]> = {
      orchestrator: Object.keys(tools),
      architect: [
        'tools_documentation',
        'search_nodes', 'list_nodes', 'list_ai_tools', 'get_database_statistics',
        'get_node_essentials', 'get_node_info', 'search_node_properties', 'get_property_dependencies', 'get_node_documentation', 'get_node_as_tool_info',
        'get_template', 'search_templates', 'list_node_templates', 'get_templates_for_task', 'list_tasks', 'get_node_for_task',
        'validate_node_minimal', 'validate_node_operation'
      ],
      builder: [
        'tools_documentation',
        'search_nodes', 'list_nodes', 'list_ai_tools', 'get_database_statistics',
        'get_node_as_tool_info', 'get_node_essentials', 'get_node_info', 'search_node_properties', 'get_property_dependencies', 'get_node_documentation',
        'get_templates_for_task', 'search_templates', 'list_node_templates', 'get_template', 'list_tasks', 'get_node_for_task',
        'validate_node_minimal', 'validate_node_operation', 'validate_workflow', 'validate_workflow_connections', 'validate_workflow_expressions',
        'n8n-credentials-crud'
      ],
      qa: [
        'tools_documentation',
        'get_node_essentials', 'search_node_properties',
        'validate_node_minimal', 'validate_node_operation', 'validate_workflow', 'validate_workflow_connections', 'validate_workflow_expressions',
        'n8n_get_workflow', 'n8n_get_workflow_details', 'n8n_get_workflow_structure', 'n8n_get_workflow_minimal', 'n8n_list_executions', 'n8n_get_execution', 'n8n_validate_workflow',
        'n8n_update_partial_workflow',
        'search_templates', 'get_node_for_task',
        'n8n-credentials-crud'
      ],
      deployer: [
        'tools_documentation',
        'validate_workflow',
        'n8n_health_check', 'n8n_create_workflow', 'n8n_update_partial_workflow', 'n8n_validate_workflow', 'n8n_trigger_webhook_workflow',
        'n8n_get_workflow', 'n8n_list_workflows', 'n8n_delete_workflow', 'n8n_update_full_workflow',
        'n8n_list_executions', 'n8n_get_execution', 'n8n_delete_execution',
        'n8n_list_available_tools', 'n8n_diagnostic',
        'activate-n8n-workflow'
      ],
    };
    const allowList = new Set(MINIMAL[role]);
    const minimalOut: Record<string, any> = {};
    for (const [toolId, def] of Object.entries(tools)) {
      if (allowList.has(toolId)) minimalOut[toolId] = def;
    }
    if (Object.keys(minimalOut).length > 0) return minimalOut;
  }
  return out;
}


