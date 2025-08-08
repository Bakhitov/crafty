#!/usr/bin/env node

// Настройка переменных окружения
process.env.DATABASE_URL = 'postgresql://postgres:Ginifi51!@db.wyehpfzafbjfvyjzgjss.supabase.co:5432/postgres';
process.env.N8N_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZDEwMDNhYS0yNWM1LTQ3YTYtOTNhYy01NjNkM2Y2NWE5M2UiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzU0NDg0NDgwLCJleHAiOjE5MDMyMDEyMDB9.O_zo3cvkA3bVKjr7hynM7vpORiFH9D-4pZbWe0eWfKA';
process.env.N8N_API_URL = 'https://n8n.srv945365.hstgr.cloud';

const { Client } = require('pg');

async function testTelegramFlow() {
  console.log('🚀 ТЕСТИРОВАНИЕ TELEGRAM FLOW');
  console.log('=' * 50);
  
  // ЭТАП 1: Поиск в базе данных
  console.log('\\n🔍 ЭТАП 1: Поиск API в базе данных');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  
  try {
    await client.connect();
    console.log('✅ Подключение к Supabase успешно');
    
    // Точный поиск по name
    console.log('🔍 Ищем точное совпадение для "telegram"...');
    let searchQuery = `
      SELECT name, "displayName", properties
      FROM credentials
      WHERE LOWER(name) = LOWER($1)
      LIMIT 1
    `;
    
    let result = await client.query(searchQuery, ['telegram']);
    console.log(`📊 Результатов точного поиска: ${result.rows.length}`);
    
    // Если не найдено - частичный поиск
    if (result.rows.length === 0) {
      console.log('🔍 Точного совпадения нет, ищем частично...');
      searchQuery = `
        SELECT name, "displayName", properties
        FROM credentials
        WHERE LOWER("displayName") LIKE LOWER($1)
        LIMIT 5
      `;
      
      result = await client.query(searchQuery, ['%telegram%']);
      console.log(`📊 Результатов частичного поиска: ${result.rows.length}`);
    }
    
    if (result.rows.length === 0) {
      console.log('❌ API не найден в базе данных');
      return;
    }
    
    const apiData = result.rows[0];
    console.log(`🎯 Найден API: ${apiData.name} - ${apiData.displayName}`);
    
    // ЭТАП 2: Парсинг properties
    console.log('\\n⚙️ ЭТАП 2: Парсинг properties');
    const properties = apiData.properties;
    console.log(`📋 Количество properties: ${properties.length}`);
    
    const fields = [];
    properties.forEach((prop, index) => {
      console.log(`\\n${index + 1}. ${prop.name}:`);
      console.log(`   Display: ${prop.displayName}`);
      console.log(`   Type: ${prop.type}`);
      console.log(`   Default: ${JSON.stringify(prop.default)}`);
      console.log(`   Required: ${prop.default === undefined || prop.default === null ? 'YES' : 'NO'}`);
      console.log(`   Password: ${prop.typeOptions?.password ? 'YES' : 'NO'}`);
      
      fields.push({
        name: prop.name,
        displayName: prop.displayName,
        required: prop.default === undefined || prop.default === null,
        isPassword: prop.typeOptions?.password || false,
        default: prop.default
      });
    });
    
    // ЭТАП 3: Формирование примера
    console.log('\\n💬 ЭТАП 3: Пример использования');
    console.log('Для создания credentials используйте:');
    console.log('{');
    console.log('  "search_term": "telegram",');
    console.log('  "credential_name": "My Telegram Bot",');
    console.log('  "credential_data": {');
    
    fields.forEach((field, index) => {
      let example = field.isPassword ? '"your_secret_here"' : 
                   field.default !== undefined ? JSON.stringify(field.default) : '"your_value"';
      let comment = field.required ? ' // required' : ' // optional with default';
      console.log(`    "${field.name}": ${example}${index < fields.length - 1 ? ',' : ''}${comment}`);
    });
    
    console.log('  }');
    console.log('}');
    
    // ЭТАП 4: Тест автозаполнения
    console.log('\\n🔧 ЭТАП 4: Тест автозаполнения default значений');
    const userInput = { "accessToken": "7961413009:AAGEp-pakPC5OmvgTyXBLmNGoSlLdCAzg28" };
    console.log('Пользователь передал:', JSON.stringify(userInput, null, 2));
    
    const enrichedData = { ...userInput };
    fields.forEach(field => {
      if (enrichedData[field.name] === undefined && field.default !== undefined) {
        enrichedData[field.name] = field.default;
        console.log(`✅ Автозаполнено ${field.name}: ${JSON.stringify(field.default)}`);
      }
    });
    
    console.log('Финальные данные для N8N:', JSON.stringify(enrichedData, null, 2));
    
    // ЭТАП 5: Тест N8N API (без реального создания)
    console.log('\\n🚀 ЭТАП 5: Подготовка запроса к N8N API');
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const requestBody = {
      name: `My Telegram Bot - ${timestamp}`,
      type: apiData.name,
      data: enrichedData
    };
    
    console.log('Тело запроса для N8N:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log(`\\nURL: ${process.env.N8N_API_URL}/api/v1/credentials`);
    console.log(`API Key: ${process.env.N8N_API_KEY.substring(0, 30)}...`);
    
    console.log('\\n✅ ВСЕ ЭТАПЫ ПРОШЛИ УСПЕШНО!');
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    console.error('Детали:', error);
  } finally {
    await client.end();
  }
}

testTelegramFlow().catch(console.error);