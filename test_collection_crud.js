const axios = require('axios');
const FormData = require('form-data');

async function testCollectionCrud() {
  const baseUrl = 'http://localhost:5000/api';
  console.log('\n--- Comprehensive Senior-Dev Test: Collection CRUD Lifecycle ---');

  try {
    // 1. CREATE Collection (C)
    console.log('1. [CREATE] Creating collection "Financial Audits 2024"...');
    const createRes = await axios.post(`${baseUrl}/collections`, {
      name: 'Financial Audits 2024',
      scope: 'professional',
      description: 'Audit logs and balance sheets for year 2024',
      color: '#0284c7',
    });
    const col = createRes.data.collection;
    console.log(`✓ Collection created: "${col.name}" (ID: ${col.id}, Scope: ${col.scope})`);

    // 2. Upload file and assign to this collection
    console.log('\nUploading test file into this collection...');
    const form = new FormData();
    form.append('file', Buffer.from('Q1 Audit Report: Balance Sheet OK'), {
      filename: 'q1_audit_report.txt',
      contentType: 'text/plain',
    });
    form.append('collectionId', col.id);
    form.append('collectionName', col.name);

    const uploadRes = await axios.post(`${baseUrl}/upload`, form, {
      headers: form.getHeaders(),
    });
    const doc = uploadRes.data.document;
    console.log(`✓ Document uploaded into collection: "${doc.collectionName}" (Doc ID: ${doc.id})`);

    // 3. READ Collection (R)
    console.log('\n2. [READ] Fetching collection details and documents via GET /api/collections/:id...');
    const getRes = await axios.get(`${baseUrl}/collections/${col.id}`);
    const colDetails = getRes.data.collection;
    console.log(`✓ Read Collection: "${colDetails.name}", Doc Count: ${colDetails.documentCount}, Total Bytes: ${colDetails.totalBytes}`);
    if (colDetails.documentCount !== 1) {
      throw new Error(`Expected 1 document in collection, found ${colDetails.documentCount}`);
    }

    // 4. UPDATE Collection (U) - Test Name Change & Cascade
    console.log('\n3. [UPDATE] Renaming collection to "Fiscal Year 2024 Audits" and updating scope to personal...');
    const updateRes = await axios.patch(`${baseUrl}/collections/${col.id}`, {
      name: 'Fiscal Year 2024 Audits',
      scope: 'personal',
    });
    const updatedCol = updateRes.data.collection;
    console.log(`✓ Collection updated: Name = "${updatedCol.name}", Scope = "${updatedCol.scope}"`);

    // Verify document was automatically synchronized with the new collection name and scope!
    const docCheckRes = await axios.get(`${baseUrl}/documents/${doc.id}`);
    const syncedDoc = docCheckRes.data.metadata;
    console.log(`✓ Verified Document Auto-Sync: collectionName = "${syncedDoc.collectionName}", scope = "${syncedDoc.scope}"`);
    if (syncedDoc.collectionName !== 'Fiscal Year 2024 Audits' || syncedDoc.scope !== 'personal') {
      throw new Error('Document was not automatically synchronized with updated collection!');
    }

    // 5. DELETE Collection (D) - Test Safe Unassignment
    console.log('\n4. [DELETE] Deleting collection (safe unassign mode: files go to Inbox)...');
    const deleteRes = await axios.delete(`${baseUrl}/collections/${col.id}?cascade=false`);
    console.log(`✓ Delete response:`, deleteRes.data.message);

    // Verify document is now in Inbox (Unassigned)
    const afterDeleteDocRes = await axios.get(`${baseUrl}/documents/${doc.id}`);
    const unassignedDoc = afterDeleteDocRes.data.metadata;
    console.log(`✓ Document after collection deletion: collectionId = ${unassignedDoc.collectionId}, collectionName = "${unassignedDoc.collectionName}"`);
    if (unassignedDoc.collectionId !== null) {
      throw new Error('Document collectionId was not set to null after collection deletion!');
    }

    // 6. Cleanup test file
    console.log('\nCleaning up test document...');
    await axios.delete(`${baseUrl}/documents/${doc.id}`);
    console.log('✓ Cleanup complete.');

    console.log('\n🎉 ALL COLLECTION CRUD OPERATIONS PASSED WITH 100% INTEGRITY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

testCollectionCrud();

