// Простой тест для диагностики проблемы с credentials tool

import { n8nCredentialsTool } from './src/mastra/tools/n8n-credentials-tool.js';

async function testCredentialsTool() {
  console.log('🔍 Testing n8n credentials tool...\n');
  
  try {
    // Test 1: Search for telegramApi (как в вашем curl примере)
    console.log('Test 1: Searching for telegramApi...');
    const searchResult = await n8nCredentialsTool.execute({
      context: {
        search_term: 'telegramApi',
        credential_name: 'Test Telegram Bot'
      }
    });
    
    console.log('Search result:', JSON.stringify(searchResult, null, 2));
    
    if (searchResult.required_fields) {
      console.log('\nRequired fields found:', searchResult.required_fields);
      
      // Test 2: Try to create credentials
      console.log('\nTest 2: Creating credentials...');
      const createResult = await n8nCredentialsTool.execute({
        context: {
          search_term: 'telegramApi',
          credential_name: 'Test Telegram Bot',
          credential_data: {
            accessToken: '7961413009:AAGEp-pakPC5OmvgTyXBLmNGoSlLdCAzg28'
          }
        }
      });
      
      console.log('Create result:', JSON.stringify(createResult, null, 2));
    }
    
  } catch (error) {
    console.error('❌ Error during test:', error);
    
    // Detailed error analysis
    if (error.message.includes('database')) {
      console.error('💾 Database connection issue. Check DATABASE_URL environment variable.');
    } else if (error.message.includes('fetch')) {
      console.error('🌐 Network/API issue. Check n8n API endpoint and key.');
    } else {
      console.error('🔧 Tool logic issue:', error.stack);
    }
  }
}

// Check environment
console.log('🔧 Environment Check:');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ Not set');
console.log('');

testCredentialsTool();