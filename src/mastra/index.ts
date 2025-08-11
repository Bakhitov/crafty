
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { n8nAgent } from './agents/n8nAgent';
import { orchestratorAgent, architectAgent, builderAgent, deployerAgent, qaAgent } from './agents/n8nteam';
import { NewAgentNetwork } from '@mastra/core/network/vNext';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { TelegramIntegration } from './integrations/telegramN8nTeam';
import { BotRegistry } from './services/botRegistry';
import { UserCacheService } from './services/userCache';
import { UserValidationService } from './services/userValidationService';
import { UserRegistrationService } from './services/userRegistrationService';
import { env } from './config/environment';
import { mcpPool } from './mcp';
import { RuntimeContext } from '@mastra/core/di';
import type { UserRuntimeContext } from './mcp';

// Export tools
export { n8nActivateTool } from './tools/n8n-activate-tool';
// export { n8nCredentialsTool } from './tools/n8n-credentials-tool'; // deprecated
export { n8nVariablesTool } from './tools/n8n-variables-tool';
export { n8nCredentialsCrudTool } from './tools/n8n-credentials-crud-tool';
// export { weatherTool } from './tools/weather-tool';

// Export MCP utilities
export { createMcpClient, getN8nApiKey, type UserRuntimeContext } from './mcp';

const storage = new PostgresStore({
  connectionString: env.database.url,
});

// Initialize User Cache Service
export const userCache = new UserCacheService(
  env.database.url,
  env.database.cacheRefreshInterval
);

export const mastra = new Mastra({
  storage,
  agents: { n8nAgent, orchestratorAgent, architectAgent, builderAgent, deployerAgent, qaAgent },
  workflows: {},
  logger: new PinoLogger({
    name: 'Mastra',
    level: env.logging.level,
  }),
  telemetry: {
    serviceName: 'crafty',
    enabled: env.telemetry.enabled,
    export: { type: 'otlp' },
  },
  // Enable HTTP server with middleware to support invocation from any source
  server: {
    cors: { origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'] },
    middleware: [
      async (c, next) => {
        // Mini App page for Telegram WebApp configs
        try {
          const url = new URL(c.req.url);
          const pathname = url.pathname;
          if (c.req.method === 'GET' && pathname === '/miniapp') {
            const chatId = url.searchParams.get('chatId') || '';
            const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <title>Настройки</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif; margin: 0; padding: 0; color: var(--tg-theme-text-color,#111); background: var(--tg-theme-bg-color,#fff); -webkit-font-smoothing: antialiased; }
      .container { width: 100%; max-width: 520px; margin: 0 auto; padding: 16px; }
      h1 { font-size: 18px; margin: 0 0 12px; color: var(--tg-theme-text-color,#111); }
      .group { margin-bottom: 12px; }
      label { display: block; font-size: 12px; margin-bottom: 6px; opacity: 0.8; }
      input, select { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid rgba(0,0,0,.12); background: var(--tg-theme-secondary-bg-color,#f2f2f2); color: var(--tg-theme-text-color,#111); outline: none; }
      input::placeholder { opacity: .6; }
      .row { display: grid; grid-template-columns: 1fr; gap: 10px; }
      .hint { font-size: 12px; opacity: .7; }
      .card { border-radius: 12px; padding: 12px; background: var(--tg-theme-secondary-bg-color,#f6f6f6); box-shadow: 0 1px 0 rgba(0,0,0,.04) inset; }
      .btn { padding: 12px; border-radius: 10px; border: 1px solid rgba(0,0,0,.12); background: var(--tg-theme-secondary-bg-color,#f5f5f5); color: var(--tg-theme-text-color,#111); text-align: center; cursor: pointer; }
      .btn:active { transform: translateY(1px); opacity: .95; }
      .btn.primary { background: var(--tg-theme-button-color,#2481cc); color: var(--tg-theme-button-text-color,#fff); border: 1px solid transparent; }
      .btn.warn { background: #c62828; color: #fff; border-color: rgba(0,0,0,.12); }
      .btn.info { background: #1565c0; color: #fff; border-color: rgba(0,0,0,.12); }
      .btn.pay { background: #ef6c00; color: #fff; border-color: rgba(0,0,0,.12); }
      .toolbar { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .toolbar .btn { padding: 14px; }
      .link { color: var(--tg-theme-link-color,#2481cc); text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="container">
      <div id="viewHome">
        <h1>Главная</h1>
        <div class="card">
          <div class="hint">ID аккаунта: <span id="chatIdView">${chatId || 'не указан'}</span></div>
          <div class="hint" style="margin-top:6px;">Текущий ID чата : <span id="threadView">—</span></div>
        </div>

        <div class="card" style="margin-top:12px;">
          <div class="toolbar">
            <button id="btn_new" class="btn primary">🆕 Новый чат</button>
            <button id="btn_chats" class="btn">🗂 Список чатов</button>
            <button id="btn_info" class="btn info">ℹ️ Инфо</button>
            <button id="btn_pay" class="btn pay">💳 Оплата</button>
          </div>
          <div class="row" style="margin-top:10px;">
             <button id="btn_configs" class="btn">Конфиги</button>
             <button id="btn_refresh" class="btn">Обновить состояние</button>
            <button id="btn_support" class="btn">🆘 Поддержка</button>
          </div>
        </div>
      </div>

      <div id="viewConfigs" style="display:none;">
        <h1>Конфиги</h1>
        <div class="card">
        <div class="group">
          <label>LLM провайдер</label>
          <select id="provider_llm"></select>
        </div>
        <div class="group">
          <label>LLM модель</label>
          <select id="model_llm"></select>
        </div>
        <div class="group">
          <label>LLM API key</label>
          <input id="api_key_llm" placeholder="sk-..." />
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="group">
          <label>n8n URL (если используете свой сервер)</label>
          <input id="n8n_url" placeholder="https://n8n.example.com" />
        </div>
        <div class="group">
           <label>n8n API key</label>
           <input id="n8n_api_key" placeholder="personal-n8n-key" />
        </div>
      </div>
        <div class="row" style="margin-top:10px;">
          <button id="btn_back" class="btn">Назад</button>
        </div>
      </div>
    </div>
    <script>
      const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      const CATALOG = [
        { key: 'openai', name: 'OpenAI', models: ['gpt-4o','gpt-4o-mini','gpt-4.1','gpt-4.1-mini'] },
        { key: 'anthropic', name: 'Anthropic', models: ['claude-3-5-sonnet-20240620','claude-3-5-haiku-20241022'] },
        { key: 'google', name: 'Google Generative AI', models: ['gemini-1.5-flash','gemini-1.5-pro'] },
        { key: 'mistral', name: 'Mistral', models: ['mistral-large-latest','mistral-small-latest'] },
        { key: 'groq', name: 'Groq', models: ['llama-3.3-70b-versatile','llama-3.1-8b-instant'] },
      ];

      const $prov = document.getElementById('provider_llm');
      const $model = document.getElementById('model_llm');
      const $chatIdView = document.getElementById('chatIdView');
      const $chatIdView2 = document.getElementById('chatIdView2');
      const $threadView = document.getElementById('threadView');
      const $viewHome = document.getElementById('viewHome');
      const $viewConfigs = document.getElementById('viewConfigs');

      function fillProviders(selected) {
        $prov.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— выберите —';
        if (!selected) placeholder.selected = true;
        $prov.appendChild(placeholder);
        CATALOG.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.key; opt.textContent = p.name; if (p.key === selected) opt.selected = true;
          $prov.appendChild(opt);
        });
      }
      function fillModels(providerKey, selectedModel) {
        $model.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— выберите —';
        if (!selectedModel) placeholder.selected = true;
        $model.appendChild(placeholder);
        if (!providerKey) return;
        const entry = CATALOG.find(p => p.key === providerKey) || null;
        if (!entry) return;
        entry.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m; opt.textContent = m; if (m === selectedModel) opt.selected = true;
          $model.appendChild(opt);
        });
      }

      $prov.addEventListener('change', () => fillModels($prov.value));

      function resolveChatId() {
        let id = '${chatId}'.trim();
        if (!id && tg && tg.initDataUnsafe) {
          id = String(tg.initDataUnsafe.chat?.id || tg.initDataUnsafe.user?.id || '');
        }
        if ($chatIdView) $chatIdView.textContent = id || 'не указан';
        return id;
      }

      async function loadConfig() {
        const chatId = resolveChatId();
        let cfg = null;
        try {
          if (chatId) {
            const r = await fetch('/configs/user?chatId=' + encodeURIComponent(chatId));
            if (r.ok) cfg = await r.json();
          }
        } catch {}
        const provider = cfg?.provider_llm || '';
        fillProviders(provider);
        fillModels(provider, cfg?.model_llm || '');
        const $llmKey = document.getElementById('api_key_llm');
        if ($llmKey) {
          if (cfg?.api_key_llm_masked) {
            $llmKey.value = cfg.api_key_llm_masked;
            $llmKey.dataset.masked = '1';
            $llmKey.dataset.original = cfg.api_key_llm_masked;
          } else {
            $llmKey.value = '';
            delete $llmKey.dataset.masked;
            delete $llmKey.dataset.original;
          }
        }
        const $n8nUrl = document.getElementById('n8n_url');
        if ($n8nUrl) $n8nUrl.value = cfg?.n8n_url || '';
        const $n8nKey = document.getElementById('n8n_api_key');
        if ($n8nKey) {
          if (cfg?.n8n_api_key_masked) {
            $n8nKey.value = cfg.n8n_api_key_masked;
            $n8nKey.dataset.masked = '1';
            $n8nKey.dataset.original = cfg.n8n_api_key_masked;
          } else {
            $n8nKey.value = '';
            delete $n8nKey.dataset.masked;
            delete $n8nKey.dataset.original;
          }
        }
        if ($threadView) $threadView.textContent = cfg?.last_thread_id || '—';
        if ($chatIdView2) $chatIdView2.textContent = chatId || 'не указан';
      }

      // Unmask-on-edit: if user changes the masked key, treat as new value
      const $n8nKeyInput = document.getElementById('n8n_api_key');
      if ($n8nKeyInput) {
        $n8nKeyInput.addEventListener('input', (e) => {
          const el = e.target;
          if (el && el.dataset && el.dataset.masked === '1') {
            if (el.value !== (el.dataset.original || '')) {
              delete el.dataset.masked;
            }
          }
        });
      }
      const $llmKeyInput = document.getElementById('api_key_llm');
      if ($llmKeyInput) {
        $llmKeyInput.addEventListener('input', (e) => {
          const el = e.target;
          if (el && el.dataset && el.dataset.masked === '1') {
            if (el.value !== (el.dataset.original || '')) {
              delete el.dataset.masked;
            }
          }
        });
      }

      async function saveConfig() {
        const $n8nUrl = document.getElementById('n8n_url');
        const $n8nKey = document.getElementById('n8n_api_key');
        const $llmKey = document.getElementById('api_key_llm');
        const keyVal = $n8nKey ? $n8nKey.value.trim() : '';
        const isMasked = $n8nKey && $n8nKey.dataset ? $n8nKey.dataset.masked === '1' : false;
        const originalMasked = $n8nKey && $n8nKey.dataset ? ($n8nKey.dataset.original || '') : '';
        const llmKeyVal = $llmKey ? $llmKey.value.trim() : '';
        const llmIsMasked = $llmKey && $llmKey.dataset ? $llmKey.dataset.masked === '1' : false;
        const llmOriginalMasked = $llmKey && $llmKey.dataset ? ($llmKey.dataset.original || '') : '';

        const payload = {
          chatId: resolveChatId(),
          provider_llm: $prov.value,
          model_llm: $model.value,
          n8n_url: $n8nUrl ? $n8nUrl.value.trim() : '',
        };
        if (!(llmIsMasked && llmKeyVal === llmOriginalMasked)) {
          payload.api_key_llm = llmKeyVal;
        }
        if (!(isMasked && keyVal === originalMasked)) {
          payload.n8n_api_key = keyVal;
        }
        const r = await fetch('/configs/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (tg) {
          try { tg.HapticFeedback.impactOccurred('light'); } catch {}
          if (r.ok) tg.showAlert('Сохранено'); else tg.showAlert('Ошибка сохранения');
        }
      }

      async function newDialog() {
        const chatId = resolveChatId();
        if (!chatId) return tg && tg.showAlert('chatId не определён');
        const r = await fetch('/configs/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId }) });
        const j = await r.json().catch(()=>({}));
        if ($threadView && j?.threadId) $threadView.textContent = j.threadId;
        if (tg) { try { tg.HapticFeedback.notificationOccurred('success'); } catch {} tg.showAlert('Новый диалог создан'); }
      }

      function openChats() {
        const chatId = resolveChatId();
        const url = '/miniapp/chats?chatId=' + encodeURIComponent(chatId || '');
        window.location.href = url;
      }

      function showInfo() {
        const chatId = resolveChatId();
        const url = '/miniapp/info?chatId=' + encodeURIComponent(chatId || '');
        window.location.href = url;
      }

      async function showPay() {
        const chatId = resolveChatId();
        if (!chatId) {
          if (tg) tg.showAlert('chatId не определён');
          return;
        }
        try {
          const r = await fetch('/miniapp/pay/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId }) });
          const j = await r.json().catch(()=>({}));
          if (r.ok && j && j.success) {
            if (tg) { try { tg.HapticFeedback.notificationOccurred('success'); } catch {} tg.showAlert('Аккаунт активирован'); }
          } else {
            if (tg) { try { tg.HapticFeedback.notificationOccurred('error'); } catch {} tg.showAlert('Не удалось активировать'); }
          }
        } catch (_) {
          if (tg) { try { tg.HapticFeedback.notificationOccurred('error'); } catch {} tg.showAlert('Ошибка сети'); }
        }
      }

      function openSupport() {
        const tel = '77066318623';
        // Try Telegram deep link first, then fallback to t.me and alert
        const deepLink = 'tg://resolve?phone=' + tel;
        const webLink = 'https://t.me/+' + tel;
        try {
          window.location.href = deepLink;
          setTimeout(() => {
            // If deep link didn't work (no Telegram), open web link
            window.open(webLink, '_blank');
          }, 500);
        } catch (_) {
          try { window.open(webLink, '_blank'); } catch {}
          if (tg) tg.showAlert('Свяжитесь с поддержкой в Telegram: +' + tel);
        }
      }

      document.getElementById('btn_new').addEventListener('click', newDialog);
      document.getElementById('btn_chats').addEventListener('click', openChats);
      document.getElementById('btn_info').addEventListener('click', showInfo);
      document.getElementById('btn_pay').addEventListener('click', showPay);
      document.getElementById('btn_refresh').addEventListener('click', loadConfig);
      document.getElementById('btn_support').addEventListener('click', openSupport);
      document.getElementById('btn_configs').addEventListener('click', () => {
        if ($viewHome && $viewConfigs) {
          $viewHome.style.display = 'none';
          $viewConfigs.style.display = '';
          if (tg) { tg.MainButton.show(); tg.MainButton.setText('Сохранить настройки'); }
        }
      });
      document.getElementById('btn_back').addEventListener('click', () => {
        if ($viewHome && $viewConfigs) {
          $viewConfigs.style.display = 'none';
          $viewHome.style.display = '';
          if (tg) { tg.MainButton.hide(); }
        }
      });

      if (tg) {
        tg.ready();
        tg.MainButton.setText('Сохранить настройки');
        tg.MainButton.onClick(saveConfig);
        tg.MainButton.hide();
        try { tg.expand(); } catch {}
      }

      loadConfig();
    </script>
  </body>
  </html>`;
            return c.html(html, 200);
          }

          // Chats list page
          if (c.req.method === 'GET' && pathname === '/miniapp/chats') {
            const chatId = url.searchParams.get('chatId') || '';
            const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <title>Список чатов</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif; margin: 0; padding: 16px; }
      .item { padding: 12px; border: 1px solid rgba(0,0,0,.12); border-radius: 10px; margin-bottom: 10px; display:flex; justify-content: space-between; align-items:center; }
      .meta { font-size: 12px; opacity: .7; }
      .btn { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #f5f5f5; cursor: pointer; }
      .btn.warn { background:#c62828; color:#fff; border-color: rgba(0,0,0,.12); }
      .row { display:flex; gap:8px; }
    </style>
  </head>
  <body>
    <h1>Список чатов</h1>
    <div id="list"></div>
    <div style="margin-top:12px;">
      <button id="btn_back" class="btn">Назад</button>
    </div>
    <script>
      const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      const chatId = ${JSON.stringify(chatId)};
      async function load() {
        const r = await fetch('/threads/list?chatId=' + encodeURIComponent(chatId));
        const j = await r.json().catch(()=>({threads:[]}));
        const $list = document.getElementById('list');
        $list.innerHTML = '';
        (j.threads || []).forEach(t => {
          const div = document.createElement('div');
          div.className = 'item';
          const left = document.createElement('div');
          left.innerHTML = '<div><b>' + (t.title || t.id) + '</b></div>' + '<div class="meta">' + t.id + '</div>';
          const right = document.createElement('div');
          right.className = 'row';
          const del = document.createElement('button');
          del.className = 'btn warn';
          del.textContent = 'Удалить';
          del.onclick = async () => {
            const rr = await fetch('/threads/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chatId, threadId: t.id }) });
            if (tg) { try { tg.HapticFeedback.notificationOccurred('warning'); } catch {} }
            await load();
          };
          right.appendChild(del);
          div.appendChild(left); div.appendChild(right);
          $list.appendChild(div);
        });
      }
      document.getElementById('btn_back').addEventListener('click', () => { window.history.back(); });
      if (tg) { tg.ready(); }
      load();
    </script>
  </body>
  </html>`;
            return c.html(html, 200);
          }

          // Info page with full description of the agent team and how to interact
          if (c.req.method === 'GET' && pathname === '/miniapp/info') {
            const chatId = url.searchParams.get('chatId') || '';
            const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <title>Информация об агентах</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      * { box-sizing: border-box; }
      body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif; margin: 0; padding: 0; color: var(--tg-theme-text-color,#111); background: var(--tg-theme-bg-color,#fff); }
      .container { width: 100%; max-width: 680px; margin: 0 auto; padding: 12px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      h2 { font-size: 16px; margin: 16px 0 8px; }
      .card { border-radius: 12px; padding: 12px; background: var(--tg-theme-secondary-bg-color,#f6f6f6); box-shadow: 0 1px 0 rgba(0,0,0,.04) inset; }
      .meta { font-size: 12px; opacity: .7; margin-bottom: 8px; }
      ul { padding-left: 18px; }
      li { margin-bottom: 6px; }
      .btn { padding: 10px 12px; border-radius: 10px; border: 1px solid rgba(0,0,0,.12); background: var(--tg-theme-secondary-bg-color,#f5f5f5); color: var(--tg-theme-text-color,#111); text-align: center; cursor: pointer; display:inline-block; }
      .btn:active { transform: translateY(1px); opacity: .95; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>О команде агентов n8n</h1>
      <div class="meta">ID аккаунта: ${chatId || 'не указан'}</div>
      <div class="card">
        <h2>Что это за команда</h2>
        <p>Это связка специализированных агентов для работы с n8n: от идеи до продакшн‑деплоя. Ведёт процесс <b>Оркестратор</b>, а задачи выполняют: <b>Архитектор</b>, <b>Сборщик</b>, <b>QA</b> и <b>Деплойер</b>.</p>
        <ul>
          <li><b>Оркестратор</b>: определяет режим (полный цикл или ускоренный), планирует, передаёт задачи нужным специалистам и следит за качеством.</li>
          <li><b>Архитектор</b>: проектирует архитектуру, сначала ищет готовые шаблоны и паттерны, потом подбирает узлы.</li>
          <li><b>Сборщик (Builder)</b>: реализует рабочий JSON воркфлоу с таймаутами, ретраями, обработкой ошибок.</li>
          <li><b>QA</b>: валидирует узлы, соединения и выражения, готовит и прогоняет сценарии тестов, диагностирует сбои.</li>
          <li><b>Деплойер</b>: разворачивает и активирует, проверяет первые исполнения, даёт статусы и next‑steps.</li>
        </ul>
        <p><b>Принципы:</b> "Сначала шаблоны", минимальный кастом‑код, валидировать рано и часто, 3–5 узлов решают 80% задач.</p>
      </div>

      <div class="card" style="margin-top:12px;">
        <h2>Как выглядит процесс</h2>
        <ul>
          <li><b>Полный цикл</b>: Архитектор → Сборщик → QA → Деплойер. Подходит, когда есть идея/цель, но нет точных требований.</li>
          <li><b>Ускоренный</b>: Сборщик → QA → Деплойер. Если вы точно знаете нужные узлы/потоки.</li>
          <li><b>Креды заранее</b>: при нехватке credentials агент предложит создать их через инструмент <code>n8n-credentials-crud</code>.</li>
          <li><b>Активация</b>: после деплоя — активация (инструмент <code>activate-n8n-workflow</code>), затем быстрая проверка вебхуков/исполнений.</li>
        </ul>
      </div>

      <div class="card" style="margin-top:12px;">
        <h2>Как общаться, чтобы достичь результата</h2>
        <ul>
          <li><b>Давайте цель и контекст</b>: источник данных, куда писать результат, периодичность/триггеры, ограничения по времени/ретраям.</li>
          <li><b>Уточняйте интеграции</b>: какие сервисы используются (например, Salesforce, PostgreSQL, Telegram, Slack) — это ускорит подготовку кредов.</li>
          <li><b>Формулируйте критерии успеха</b>: что считаем готовностью (например, «ежедневный отчёт в 09:00 в Google Sheets без ошибок»).</li>
          <li><b>Начните с простого</b>: 3–5 узлов, затем итеративно усложняйте.</li>
        </ul>
        <h2>Примеры хороших запросов</h2>
        <ul>
          <li>«Нужен воркфлоу: раз в день в 09:00 получать продажи из API и сохранять в Google Sheets. Если ошибок &gt;5% — слать оповещение в Slack.»</li>
          <li>«Есть вебхук Stripe — при событии payment_succeeded валидировать данные, обновлять PostgreSQL и отправлять письмо клиенту.»</li>
          <li>«Исправьте мой воркфлоу: HTTP‑узел падает по таймауту. Нужны ретраи и корректная обработка 429/5xx.»</li>
          <li>«Задеплойте и активируйте мой ETL: три узла — загрузить, трансформировать, записать в БД; мониторим первые 5 прогонов.»</li>
        </ul>
      </div>

      <div class="card" style="margin-top:12px;">
        <h2>Чек‑лист качества</h2>
        <ul>
          <li>Таймауты и ретраи на внешних вызовах</li>
          <li>Корректные соединения узлов и валидация выражений</li>
          <li>Ясная обработка ошибок: критичные — стоп, некритичные — лог/продолжить</li>
          <li>Креды оформлены и привязаны к узлам</li>
          <li>Первые исполнения проверены (успех &gt; 90%)</li>
        </ul>
      </div>

      <div style="margin-top:12px;">
        <button id="btn_back" class="btn">Назад</button>
      </div>
    </div>
    <script>
      const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      if (tg) tg.ready();
      document.getElementById('btn_back').addEventListener('click', () => { window.history.back(); });
    </script>
  </body>
  </html>`;
            return c.html(html, 200);
          }

          if (c.req.method === 'GET' && pathname === '/configs/user') {
            const chatIdQ = url.searchParams.get('chatId');
            if (!chatIdQ) return c.json({ error: 'chatId required' }, 400);
            const user = userCache.getUserByContactId(chatIdQ);
            const dbUser = await UserRegistrationService.findByContactId(chatIdQ);
            const maskKey = (k: string | null | undefined): string | null => {
              try {
                if (!k || typeof k !== 'string') return null;
                return k.length <= 8 ? `${k[0]}***${k[k.length - 1]}` : `${k.slice(0,4)}***${k.slice(-4)}`;
              } catch { return null; }
            };
            const n8n_api_key_masked = user && (user as any)?.n8n_api_key ? maskKey((user as any).n8n_api_key) : null;
            return c.json({
              contact_id: user?.contact_id || null,
              provider_llm: (user as any)?.provider_llm || null,
              model_llm: (user as any)?.model_llm || null,
              n8n_url: (user as any)?.n8n_url || null,
              has_api_key_llm: !!(user as any)?.api_key_llm,
              has_n8n_api_key: !!(user as any)?.n8n_api_key,
              api_key_llm_masked: user && (user as any)?.api_key_llm ? maskKey((user as any).api_key_llm) : null,
              n8n_api_key_masked,
              last_thread_id: dbUser?.last_thread_id || null,
            }, 200);
          }

          // API: list threads for contact via metadata.user_id filter
          if (c.req.method === 'GET' && pathname === '/threads/list') {
            const chatIdQ = url.searchParams.get('chatId');
            if (!chatIdQ) return c.json({ error: 'chatId required' }, 400);
            const resourceIds = ['orchestratorAgent','n8nAgent'];
            const collected: any[] = [];
            for (const resId of resourceIds) {
              try {
                const agentInst = mastra.getAgent(resId as any);
                const memory = agentInst?.getMemory();
                const maybeList = (memory && (memory as any).getThreadsByResourceId) ? (memory as any).getThreadsByResourceId : null;
                if (typeof maybeList === 'function') {
                  const threads = await maybeList({ resourceId: resId, orderBy: 'updatedAt', sortDirection: 'DESC' });
                  for (const t of threads || []) {
                    const meta = (t && t.metadata) || {};
                    if (meta && String(meta.user_id || '') === String(chatIdQ)) {
                      collected.push({ id: t.id, title: t.title || null, resourceId: resId, updatedAt: t.updatedAt });
                    }
                  }
                }
              } catch {}
            }
            // dedupe by id keeping latest updatedAt
            const map = new Map<string, any>();
            for (const t of collected) {
              const ex = map.get(t.id);
              if (!ex || new Date(t.updatedAt).getTime() > new Date(ex.updatedAt).getTime()) map.set(t.id, t);
            }
            return c.json({ threads: Array.from(map.values()) }, 200);
          }

          // API: delete specific thread by id (across resourceIds)
          if (c.req.method === 'POST' && pathname === '/threads/delete') {
            const body = await c.req.json().catch(() => null) as any;
            if (!body || !body.chatId || !body.threadId) return c.json({ error: 'chatId and threadId required' }, 400);
            const contactId = String(body.chatId);
            const threadId = String(body.threadId);
            try {
              const resourceIds = ['orchestratorAgent','n8nAgent'];
              for (const resId of resourceIds) {
                try {
                  const agentInst = mastra.getAgent(resId as any);
                  const memory = agentInst?.getMemory();
                  const maybeDelete = (memory && (memory as any).deleteThread) ? (memory as any).deleteThread : null;
                  if (typeof maybeDelete === 'function') {
                    try { await maybeDelete({ resourceId: resId, threadId }); } catch {}
                  }
                } catch {}
              }
              // If deleted thread was current, clear pointer
              const dbUser = await UserRegistrationService.findByContactId(contactId);
              if (dbUser?.last_thread_id === threadId) {
                await UserRegistrationService.updateLastThreadId({ contactId, lastThreadId: null });
              }
              return c.json({ success: true }, 200);
            } catch (e) {
              return c.json({ success: false, error: String(e) }, 500);
            }
          }

          if (c.req.method === 'POST' && pathname === '/configs/save') {
            const body = await c.req.json().catch(() => null) as any;
            if (!body || !body.chatId) return c.json({ error: 'chatId required' }, 400);
            const contactId = String(body.chatId);
            try {
              if (body.provider_llm || body.model_llm) {
                if (body.provider_llm && body.model_llm) {
                  await UserRegistrationService.updateLlmModel({ contactId, provider: body.provider_llm, model: body.model_llm });
                }
              }
              if (Object.prototype.hasOwnProperty.call(body, 'api_key_llm')) {
                const v = typeof body.api_key_llm === 'string' ? body.api_key_llm : null;
                await UserRegistrationService.updateLlmApiKey({ contactId, apiKey: v === '' ? null : v });
              }
              if (Object.prototype.hasOwnProperty.call(body, 'n8n_url')) {
                const v = typeof body.n8n_url === 'string' ? body.n8n_url : null;
                await UserRegistrationService.updateN8nUrl({ contactId, n8nUrl: v === '' ? null : v });
              }
              if (Object.prototype.hasOwnProperty.call(body, 'n8n_api_key')) {
                const v = typeof body.n8n_api_key === 'string' ? body.n8n_api_key : null;
                await UserRegistrationService.updateN8nApiKey({ contactId, apiKey: v === '' ? null : v });
              }
              await userCache.forceRefresh();
              return c.json({ success: true }, 200);
            } catch (e) {
              return c.json({ success: false, error: String(e) }, 500);
            }
          }

          if (c.req.method === 'POST' && pathname === '/configs/new') {
            const body = await c.req.json().catch(() => null) as any;
            if (!body || !body.chatId) return c.json({ error: 'chatId required' }, 400);
            const contactId = String(body.chatId);
            const threadId = `tg-${contactId}_${Date.now().toString()}`;
            try {
              // Create threads with metadata user_id for both agents
              const resourceIds = ['orchestratorAgent','n8nAgent'];
              for (const resId of resourceIds) {
                try {
                  const agentInst = mastra.getAgent(resId as any);
                  const memory = agentInst?.getMemory();
                  const maybeCreate = (memory && (memory as any).createThread) ? (memory as any).createThread : null;
                  if (typeof maybeCreate === 'function') {
                    try {
                      const payload = {
                        resourceId: resId,
                        threadId,
                        title: 'Новый чат',
                        metadata: { user_id: contactId },
                      };
                      await maybeCreate(payload);
                    } catch {}
                  }
                } catch {}
              }
              await UserRegistrationService.updateLastThreadId({ contactId, lastThreadId: threadId });
              return c.json({ success: true, threadId }, 200);
            } catch (e) {
              return c.json({ success: false, error: String(e) }, 500);
            }
          }

          if (c.req.method === 'POST' && pathname === '/configs/reset') {
            const body = await c.req.json().catch(() => null) as any;
            if (!body || !body.chatId) return c.json({ error: 'chatId required' }, 400);
            const contactId = String(body.chatId);
            try {
            const dbUser = await UserRegistrationService.findByContactId(contactId);
            const lastThreadId = dbUser?.last_thread_id || null;
            if (lastThreadId) {
              const resourceIds = ['orchestratorAgent','n8nAgent'];
              for (const resId of resourceIds) {
                try {
                  const agentInst = mastra.getAgent(resId as any);
                  const memory = agentInst?.getMemory();
                  const maybeDelete = (memory && (memory as any).deleteThread) ? (memory as any).deleteThread : null;
                  if (typeof maybeDelete === 'function') {
                    try { await maybeDelete({ resourceId: resId, threadId: lastThreadId }); } catch {}
                  }
                } catch {}
              }
            }
              await UserRegistrationService.updateLastThreadId({ contactId, lastThreadId: null });
              return c.json({ success: true }, 200);
            } catch (e) {
              return c.json({ success: false, error: String(e) }, 500);
            }
          }

          // Miniapp: activate user after payment (temporary)
          if (c.req.method === 'POST' && pathname === '/miniapp/pay/activate') {
            const body = await c.req.json().catch(() => null) as any;
            if (!body || !body.chatId) return c.json({ error: 'chatId required' }, 400);
            const contactId = String(body.chatId);
            try {
              await UserRegistrationService.setActive({ contactId, isActive: true });
              await userCache.forceRefresh();
              return c.json({ success: true }, 200);
            } catch (e) {
              return c.json({ success: false, error: String(e) }, 500);
            }
          }
        } catch {}

        // Populate runtimeContext from headers for downstream agent calls
        const runtimeContext = c.get('runtimeContext') as RuntimeContext<UserRuntimeContext>;
        const userChatId = c.req.header('x-user-chat-id');
        const agentName = c.req.header('x-agent-name');
        const n8nApiKey = c.req.header('x-n8n-api-key');

        if (userChatId) runtimeContext.set('user-chat-id', userChatId);
        if (agentName) runtimeContext.set('agent-name', agentName);
        if (n8nApiKey) runtimeContext.set('n8n-api-key', n8nApiKey);

        await next();
      },
    ],
  },
  // vNext agent network registration (native multi-agent orchestration)
  vnext_networks: {
    teamNetwork: new NewAgentNetwork({
      id: 'team-network',
      name: 'n8n Team Network',
      instructions:
        'You are a network of n8n specialists: Architect, Builder, QA, Deployer. Route tasks to the best primitive and ensure credentials are created and workflows are activated when needed.',
      model: ({ runtimeContext }) => orchestratorAgent.getModel({ runtimeContext }) as any,
      agents: {
        architectAgent,
        builderAgent,
        qaAgent,
        deployerAgent,
      },
      workflows: {},
      memory: new Memory({ storage }),
    }),
  },
});

// Declare telegram bot variable but don't initialize yet
export let telegramBot: TelegramIntegration | null = null;
const botRegistry = new BotRegistry();

// Initialize the user cache and validation service FIRST (with retries)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function initializeCriticalServicesWithRetry(maxAttempts: number = 5): Promise<void> {
  let attempt = 0;
  let lastError: unknown = null;
  const baseDelayMs = 2000;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      console.log(`🚀 Initializing UserCacheService (attempt ${attempt}/${maxAttempts})...`);
      await userCache.initialize();
      console.log('✅ UserCacheService initialized');
      return;
    } catch (err) {
      lastError = err;
      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`❌ UserCacheService init failed (attempt ${attempt}/${maxAttempts}). Retrying in ${backoff}ms...`, err);
      await delay(backoff);
    }
  }
  console.error('❌ UserCacheService failed to initialize after retries. Exiting.');
  throw lastError ?? new Error('UserCacheService init failed');
}

initializeCriticalServicesWithRetry().then(async () => {
  // Initialize UserValidationService with the cache instance
  UserValidationService.init(userCache);
  console.log('✅ UserValidationService initialized');
  
  // Start bots via registry (Telegram real, WhatsApp stub)
  await botRegistry.startAll();
  
  // Log application status
  console.log('🚀 Mastra Application Status:', {
    telegram: !!telegramBot,
    cache: userCache.getCacheStats(),
  });
}).catch((error) => {
  console.error('❌ Failed to initialize services (critical):', error);
  process.exit(1);
});

// Graceful shutdown handling
const gracefulShutdown = async (signal: string) => {
  console.log(`📥 Received ${signal}. Starting graceful shutdown...`);
  
  try {
    console.log('🛑 Stopping bot registry...');
    await botRegistry.stopAll();

    console.log('🛑 Disconnecting MCP client pool...');
    await mcpPool.disconnectAll();
    
    console.log('🛑 Shutting down user cache...');
    await userCache.shutdown();
    
    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Обработка uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});