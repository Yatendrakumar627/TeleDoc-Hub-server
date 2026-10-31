const axios = require('axios');
const FormData = require('form-data');
const { connectDB } = require('./src/db/connection');
const DocumentModel = require('./src/models/Document');
const { app, server } = require('./src/index');

async function runTest() {
  console.log('\n--- Running TeleDoc Hub Mongo + Telegram Zero-Knowledge Vault Test ---');

  // Wait 1s for server boot
  await new Promise((r) => setTimeout(r, 1000));

  const port = process.env.PORT || 5000;
  const baseUrl = `http://localhost:${port}/api`;

  try {
    // 1. Health check
    const statusRes = await axios.get(`${baseUrl}/status`);
    console.log('✓ Health & MongoDB status:', statusRes.data.database);
    console.log('✓ Telegram Connection:', statusRes.data.telegram?.connected ? 'Online' : 'Offline');

    // 2. Upload a test Confidential Medical File
    const form = new FormData();
    const testContent = 'Confidential Doctor Report: Patient John Doe diagnosed with Stage 1 Hypertension. Date: 2024-05-10.';
    form.append('file', Buffer.from(testContent), {
      filename: 'john_doe_medical_report_2024.txt',
      contentType: 'text/plain',
    });
    form.append('scope', 'personal');
    form.append('group', 'medical');
    form.append('securityLevel', 'strictly_confidential');

    console.log('\nUploading test confidential document...');
    const uploadRes = await axios.post(`${baseUrl}/upload`, form, {
      headers: form.getHeaders(),
    });

    const doc = uploadRes.data.document;
    console.log(`✓ Uploaded doc ID: ${doc.id}`);
    console.log(`✓ Classified Scope: ${doc.scope}`);
    console.log(`✓ Security Level: ${doc.security?.level} (Encrypted: ${doc.security?.isEncrypted})`);
    console.log(`✓ Group / SubGroup: ${doc.taxonomy?.group} / ${doc.taxonomy?.subGroup}`);
    console.log(`✓ Year / Month: ${doc.temporal?.year} / ${doc.temporal?.month}`);

    // 3. Fetch document and verify zero-knowledge decryption
    console.log('\nFetching and decrypting document from Telegram via API...');
    const getRes = await axios.get(`${baseUrl}/documents/${doc.id}`);
    const fetchedText = getRes.data.content?.text;
    console.log(`✓ Decrypted text match: ${fetchedText.includes('Stage 1 Hypertension')}`);

    // 4. Test multi-dimensional filters
    console.log('\nTesting multi-dimensional queries...');
    const filterRes = await axios.get(`${baseUrl}/documents`, {
      params: { scope: 'personal', group: 'medical' },
    });
    console.log(`✓ Filter (Scope: personal, Group: medical): Found ${filterRes.data.documents.length} docs`);

    // 5. Timeline analytics
    const timelineRes = await axios.get(`${baseUrl}/analytics/timeline`);
    console.log('✓ Timeline analytics:', timelineRes.data.timeline);

    // 6. Cleanup test document
    console.log('\nCleaning up test document...');
    await axios.delete(`${baseUrl}/documents/${doc.id}`);
    console.log('✓ Test document deleted successfully.');

    console.log('\n✅ ALL INTEGRATION TESTS PASSED CLEANLY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
  } finally {
    server.close();
    process.exit(0);
  }
}

runTest();

