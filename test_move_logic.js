const axios = require('axios');
const FormData = require('form-data');

async function testMoveLogic() {
  const baseUrl = 'http://localhost:5000/api';
  console.log('\n--- Testing Move File to Collection Logic ---');

  try {
    // 1. Upload a test file (Inbox/Unassigned)
    const form = new FormData();
    form.append('file', Buffer.from('Mutual Non-Disclosure Agreement for Project X. Confidential.'), {
      filename: 'nda_agreement.txt',
      contentType: 'text/plain',
    });

    console.log('1. Uploading test file without collection (lands in Inbox)...');
    const uploadRes = await axios.post(`${baseUrl}/upload`, form, {
      headers: form.getHeaders(),
    });

    const doc = uploadRes.data.document;
    console.log(`✓ Uploaded doc: ${doc.title} (Collection: ${doc.collectionName}, ID: ${doc.collectionId})`);

    // 2. Create a collection
    console.log('\n2. Creating target collection "Legal NDAs"...');
    const colRes = await axios.post(`${baseUrl}/collections`, {
      name: 'Legal NDAs',
      scope: 'professional',
      description: 'Corporate confidential agreements',
    });
    const col = colRes.data.collection;
    console.log(`✓ Collection created: "${col.name}" (ID: ${col.id})`);

    // 3. Move the document into the collection
    console.log(`\n3. Moving document "${doc.title}" into collection "${col.name}"...`);
    const moveRes = await axios.patch(`${baseUrl}/documents/${doc.id}/collection`, {
      collectionId: col.id,
    });
    const movedDoc = moveRes.data.document;
    console.log(`✓ Move result:`, moveRes.data.message);
    console.log(`✓ Verified Document in DB: collectionId = "${movedDoc.collectionId}", collectionName = "${movedDoc.collectionName}"`);

    if (movedDoc.collectionId !== col.id || movedDoc.collectionName !== col.name) {
      throw new Error('Collection ID or Name mismatch after move!');
    }

    // 4. Test Batch Move: move back to Inbox
    console.log('\n4. Testing batch move back to Inbox (Unassign)...');
    const batchRes = await axios.post(`${baseUrl}/documents/batch-move`, {
      documentIds: [doc.id],
      collectionId: null,
    });
    console.log(`✓ Batch move result:`, batchRes.data.message);

    // Verify in DB
    const checkRes = await axios.get(`${baseUrl}/documents/${doc.id}`);
    console.log(`✓ Document after unassign: collectionName = "${checkRes.data.metadata.collectionName}", collectionId = ${checkRes.data.metadata.collectionId}`);

    if (checkRes.data.metadata.collectionId !== null) {
      throw new Error('Failed to unassign collectionId back to null!');
    }

    // 5. Cleanup
    console.log('\n5. Cleaning up test data...');
    await axios.delete(`${baseUrl}/documents/${doc.id}`);
    await axios.delete(`${baseUrl}/collections/${col.id}`);
    console.log('✓ Cleanup complete.');

    console.log('\n✅ MOVE FILE TO COLLECTION LOGIC IS 100% OPERATIONAL & VERIFIED!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

testMoveLogic();

