const axios = require('axios');
const FormData = require('form-data');
const assert = require('assert');

const API_BASE = 'http://localhost:5000/api';

async function runMultiFileUploadTest() {
  console.log('🧪 Starting Multi-File Detection & Individual Instance Test...\n');

  try {
    // 1. Prepare 3 distinct in-memory files
    const file1Content = Buffer.from('Financial Summary 2026: Revenue $5,000,000, Expenses $3,200,000.', 'utf-8');
    const file2Content = Buffer.from('const vault = "TeleDoc Zero Knowledge Engine"; console.log(vault);', 'utf-8');
    const file3Content = Buffer.from('id,name,role\n1,Alice,Engineer\n2,Bob,Architect\n3,Charlie,Security', 'utf-8');

    const form = new FormData();
    form.append('files', file1Content, { filename: 'finance_summary_2026.txt', contentType: 'text/plain' });
    form.append('files', file2Content, { filename: 'crypto_vault_module.js', contentType: 'application/javascript' });
    form.append('files', file3Content, { filename: 'team_roster.csv', contentType: 'text/csv' });

    form.append('scope', 'professional');

    console.log('📤 Uploading 3 files simultaneously to /api/documents/upload...');
    const uploadRes = await axios.post(`${API_BASE}/documents/upload`, form, {
      headers: form.getHeaders(),
    });

    console.log('Response Status:', uploadRes.status);
    const data = uploadRes.data;

    assert.strictEqual(data.success, true, 'Upload should succeed');
    assert.strictEqual(data.count, 3, 'Should detect and process exactly 3 files');
    assert.strictEqual(data.documents.length, 3, 'Should have 3 document instances');

    console.log(`✅ Detected ${data.count} files! Inspecting individual instances:`);

    const docIds = [];
    const ivs = new Set();
    const telegramFileIds = new Set();

    data.documents.forEach((doc, idx) => {
      console.log(`\n  📄 Instance #${idx + 1}:`);
      console.log(`     ID:               ${doc.id}`);
      console.log(`     Filename:         ${doc.filename}`);
      console.log(`     Format:           ${doc.format}`);
      console.log(`     Telegram File ID: ${doc.telegramFileId}`);
      console.log(`     Encrypted:        ${doc.security.isEncrypted}`);
      console.log(`     AES-256 IV:       ${doc.security.iv}`);
      console.log(`     Taxonomy Group:   ${doc.taxonomy?.group}`);

      assert(doc.id, 'Document must have a unique ID');
      assert(doc.telegramFileId, 'Document must have an individual Telegram File ID');
      assert.strictEqual(doc.security.isEncrypted, true, 'Must be Zero-Knowledge encrypted');

      docIds.push(doc.id);
      ivs.add(doc.security.iv);
      telegramFileIds.add(doc.telegramFileId);
    });

    // Verify all 3 documents have distinct IVs and Telegram File IDs (Zero-Knowledge Isolation)
    assert.strictEqual(ivs.size, 3, 'Each individual file instance MUST have a unique AES-256 initialization vector (IV)');
    assert.strictEqual(telegramFileIds.size, 3, 'Each individual file instance MUST have its own individual Telegram storage blob');
    console.log('\n✅ Individual cryptographic & storage isolation verified: 3 distinct IVs & Telegram blobs.');

    // 2. Test downloading and decrypting each individual file instance
    console.log('\n📥 Verifying individual download & decryption for each file:');
    for (const id of docIds) {
      const getRes = await axios.get(`${API_BASE}/documents/${id}`);
      assert.strictEqual(getRes.data.metadata.id, id);
      console.log(`  ✓ Decrypted "${getRes.data.metadata.filename}" (Format: ${getRes.data.content.format}) successfully.`);
    }

    // 3. Test batch-moving these 3 files into a collection
    console.log('\n📁 Creating a collection for the batch...');
    const colRes = await axios.post(`${API_BASE}/collections`, {
      name: 'Batch Upload Project Alpha',
      scope: 'professional',
    });
    const colId = colRes.data.collection.id;

    console.log(`Moving all 3 files to collection "${colRes.data.collection.name}"...`);
    const moveRes = await axios.post(`${API_BASE}/documents/batch-move`, {
      documentIds: docIds,
      collectionId: colId,
    });

    assert.strictEqual(moveRes.data.success, true);
    assert.strictEqual(moveRes.data.modifiedCount, 3);
    console.log(`✅ Batch move successful: ${moveRes.data.message}`);

    // Verify collection reflects 3 files
    const colCheck = await axios.get(`${API_BASE}/collections/${colId}`);
    assert.strictEqual(colCheck.data.collection.documentCount, 3, 'Collection documentCount should be 3');
    assert.strictEqual(colCheck.data.collection.documents.length, 3, 'Collection documents array should have 3 items');
    console.log(`✅ Verified collection documentCount is 3, with 3 individual file instances.`);

    console.log('\n🎉 ALL MULTI-FILE INDIVIDUAL INSTANCE TESTS PASSED!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

runMultiFileUploadTest();
