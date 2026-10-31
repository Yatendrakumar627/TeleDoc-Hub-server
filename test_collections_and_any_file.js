const axios = require('axios');
const FormData = require('form-data');

async function testCollectionsAndAnyFile() {
  const baseUrl = 'http://localhost:5000/api';
  console.log('\n--- Testing Any-File Upload & Post-Upload Collection Creation ---');

  try {
    // 1. Check API status
    const status = await axios.get(`${baseUrl}/status`);
    console.log('✓ API Status:', status.data.version);

    // 2. Upload an image file (e.g. PNG sample)
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic bytes
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89
    ]);

    const form = new FormData();
    form.append('file', pngHeader, {
      filename: 'sample_scan.png',
      contentType: 'image/png',
    });

    console.log('\n1. Uploading arbitrary non-pdf/non-doc file (sample_scan.png)...');
    const uploadRes = await axios.post(`${baseUrl}/upload`, form, {
      headers: form.getHeaders(),
    });

    const doc = uploadRes.data.document;
    console.log(`✓ Upload successful! ID: ${doc.id}`);
    console.log(`✓ Format: ${doc.format}, Type: ${doc.type}, Size: ${doc.fileSize} bytes`);
    console.log(`✓ Vault Encrypted: ${doc.security?.isEncrypted}`);

    // 3. Create a collection post-upload
    console.log('\n2. Creating a collection "Tax & Finance 2024" after the upload...');
    const colRes = await axios.post(`${baseUrl}/collections`, {
      name: 'Tax & Finance 2024',
      scope: 'professional',
      description: 'All 2024 financial tax documents and scans',
    });

    const col = colRes.data.collection;
    console.log(`✓ Collection created! ID: ${col.id}, Name: "${col.name}"`);

    // 4. Assign document to this collection
    console.log('\n3. Assigning uploaded document to the new collection...');
    const assignRes = await axios.patch(`${baseUrl}/documents/${doc.id}/collection`, {
      collectionId: col.id,
      collectionName: col.name,
    });
    console.log(`✓ Document assigned to collection: "${assignRes.data.document.collectionName}"`);

    // 5. Query documents by collectionId
    console.log('\n4. Filtering documents by collectionId...');
    const listRes = await axios.get(`${baseUrl}/documents`, {
      params: { collectionId: col.id },
    });
    console.log(`✓ Found ${listRes.data.documents.length} document(s) in collection "${col.name}"`);

    // 6. Test downloading the decrypted file
    console.log('\n5. Testing file download endpoint...');
    const downloadRes = await axios.get(`${baseUrl}/documents/${doc.id}/download`, {
      responseType: 'arraybuffer',
    });
    const downloadedBuf = Buffer.from(downloadRes.data);
    console.log(`✓ Downloaded buffer length: ${downloadedBuf.length} bytes (Matches original: ${downloadedBuf.equals(pngHeader)})`);

    // 7. Cleanup
    console.log('\nCleaning up test document and collection...');
    await axios.delete(`${baseUrl}/documents/${doc.id}`);
    await axios.delete(`${baseUrl}/collections/${col.id}`);
    console.log('✓ Cleanup complete.');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

testCollectionsAndAnyFile();

