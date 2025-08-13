### Где смотреть опубликованные MCP‑инструменты

- Основной список (discovery/configuration/validation/templates и т.д.):
  - `node_modules/n8n-mcp/dist/mcp/tools.js`
- Инструменты управления n8n (создание/обновление/списки/exec/health):
  - `node_modules/n8n-mcp/dist/mcp/tools-n8n-manager.js`
- Динамически в рантайме (быстрый обзор из агента):
  - Вызовите инструмент `tools_documentation({ depth: "essentials" })`
  - Или `n8n_list_available_tools()` для списка доступных возможностей n8n‑менеджмента

Подсказка: в перечисленных файлах инструменты описаны массивами объектов с полями `name`, `description`, `inputSchema` и (где есть) `outputSchema`.


### Валидация входа/выхода и формат ответов

- Валидация входных параметров задаётся в `inputSchema` каждого инструмента:
  - тип (`type`), параметры в `properties`, обязательные поля в `required`, возможные значения через `enum`, значения по умолчанию через `default`
  - у части инструментов явно стоит `additionalProperties: false` — лишние поля будут отклонены
- Формат ответа (если зафиксирован) описан в `outputSchema`:
  - чаще всего у `validate_*` и `validate_workflow*` встречаются поля: `valid`, `summary`, `errors`, `warnings`, `suggestions`, `statistics/tips`
- Где смотреть в коде:
  - `node_modules/n8n-mcp/dist/mcp/tools.js` — документация/поиск/конфигурация/валидация (например, `validate_node_operation`, `validate_workflow` и др.)
  - `node_modules/n8n-mcp/dist/mcp/tools-n8n-manager.js` — n8n API (создать/обновить/валидировать по id/вебхук/списки/exec)

Быстрые примеры:
- `validate_node_operation` — строгий `inputSchema` с `profile: { enum: ['strict','runtime','ai-friendly','minimal'], default: 'ai-friendly' }` и подробный `outputSchema` (с ошибками/варнингами/сводкой)
- `validate_workflow` — `inputSchema` с `options.validateNodes|validateConnections|validateExpressions|profile`, и структурированный `outputSchema` c `summary`
- `n8n_update_partial_workflow` — вход: `id` (workflow) и массив `operations` (дифф‑операции)


### Где лежат описания (docs) инструментов n8n‑mcp

- Централизованные справки/генераторы документации:
  - `node_modules/n8n-mcp/dist/mcp/tools-documentation.js`
  - `node_modules/n8n-mcp/dist/mcp/tools-documentation-new.js`
  - В рантайме используйте `tools_documentation({ topic, depth })`:
    - `topic`: имя тула (например, `"search_nodes"`), или специальные гайды (`"javascript_code_node_guide"`, `"python_code_node_guide"`)
    - `depth`: `"essentials"` (кратко) или `"full"` (подробно)
- Детальные описания по категориям (разделены файлами):
  - Каталог `node_modules/n8n-mcp/dist/mcp/tool-docs/`
    - `discovery/` — `search-nodes.js`, `list-nodes.js`, `list-ai-tools.js`, ...
    - `configuration/` — `get-node-essentials.js`, `get-node-info.js`, `search-node-properties.js`, `get-property-dependencies.js`, `get-node-documentation.js`, `get-node-as-tool-info.js`
    - `validation/` — `validate-node-minimal.js`, `validate-node-operation.js`, `validate-workflow*.js`
    - `workflow_management/` — `n8n-create-workflow.js`, `n8n-update-partial-workflow.js`, `n8n-validate-workflow.js`, `n8n-trigger-webhook-workflow.js`, `n8n-*.js`
    - `system/` — `n8n-health-check.js`, `n8n-list-available-tools.js`, `n8n-diagnostic.js`
    - `templates/` — `search-templates.js`, `list-node-templates.js`, `get-template.js`, `get-templates-for-task.js`
    - `special/` — `code-node-guide.js` (гайды по Code Node для JavaScript/Python)

Быстрый ориентир:
- Список инструментов и их схемы (input/output): `mcp/tools.js`, `mcp/tools-n8n-manager.js`
- Подробный текст и примеры: `mcp/tools-documentation*.js` и всё под `mcp/tool-docs/**`
- Для быстрого обзора из агента: `tools_documentation({ depth: 'essentials' })` и тематические гайды по Code Node
