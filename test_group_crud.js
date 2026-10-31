const axios = require('axios');
const assert = require('assert');

const API_BASE = 'http://localhost:5000/api';

async function runGroupCrudTest() {
  console.log('🧪 Starting Group Feature CRUD Test (File & Collection support)...\n');

  try {
    // 1. Register a test user
    const userEmail = `group_tester_${Date.now()}@teledoc.internal`;
    const userPassword = 'GroupTestingPassword2026!';
    console.log(`1️⃣ Registering test user (${userEmail})...`);

    const regRes = await axios.post(`${API_BASE}/auth/register`, {
      email: userEmail,
      password: userPassword,
      name: 'Group Architect',
    });
    const token = regRes.data.token;
    const authHeaders = { headers: { Authorization: `Bearer ${token}` } };
    console.log('   ✓ User registered and authenticated.');

    // 2. GET /api/groups - Check groups list starts clean with zero hardcoded groups
    console.log('\n2️⃣ Fetching groups (GET /api/groups)...');
    const listRes = await axios.get(`${API_BASE}/groups`, authHeaders);
    assert.strictEqual(listRes.status, 200);
    assert(Array.isArray(listRes.data.groups), 'Should return groups array');
    console.log(`   ✓ Found ${listRes.data.groups.length} groups. Clean state verified (zero hardcoded groups).`);

    // 3. POST /api/groups - Create a custom group
    console.log('\n3️⃣ Creating a custom Group (POST /api/groups)...');
    const createGroupRes = await axios.post(
      `${API_BASE}/groups`,
      {
        name: 'Strategic AI Architecture',
        description: 'Autonomous systems, agentic pipelines, and LLM artifacts',
        color: '#6366f1',
        icon: 'Cpu',
        scope: 'professional',
      },
      authHeaders
    );
    assert.strictEqual(createGroupRes.status, 201);
    const customGroup = createGroupRes.data.group;
    assert(customGroup.id, 'Group must have an ID');
    assert.strictEqual(customGroup.name, 'Strategic AI Architecture');
    console.log(`   ✓ Group created: "${customGroup.name}" [ID: ${customGroup.id}]`);

    // 4. Create a collection and assign it to this Group
    console.log('\n4️⃣ Creating a Collection & assigning to Group...');
    const colRes = await axios.post(
      `${API_BASE}/collections`,
      {
        name: 'Agent Models 2026',
        scope: 'professional',
      },
      authHeaders
    );
    const colId = colRes.data.collection.id;

    // Assign collection to Group
    const assignColRes = await axios.patch(
      `${API_BASE}/collections/${colId}/group`,
      {
        groupId: customGroup.id,
        groupName: customGroup.name,
      },
      authHeaders
    );
    assert.strictEqual(assignColRes.data.collection.groupId, customGroup.id);
    assert.strictEqual(assignColRes.data.collection.groupName, customGroup.name);
    console.log(`   ✓ Collection "${assignColRes.data.collection.name}" assigned to Group "${customGroup.name}".`);

    // 5. Upload a document and assign it to this Group
    console.log('\n5️⃣ Uploading a File & assigning to Group...');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('files', Buffer.from('Deepmind Agentic Blueprint v2.0', 'utf-8'), {
      filename: 'agentic_blueprint.txt',
      contentType: 'text/plain',
    });
    form.append('scope', 'professional');

    const uploadRes = await axios.post(`${API_BASE}/documents/upload`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
    });
    const docId = uploadRes.data.documents[0].id;

    // Assign document to Group
    const assignDocRes = await axios.patch(
      `${API_BASE}/documents/${docId}/group`,
      {
        groupId: customGroup.id,
        groupName: customGroup.name,
      },
      authHeaders
    );
    assert.strictEqual(assignDocRes.data.document.groupId, customGroup.id);
    assert.strictEqual(assignDocRes.data.document.taxonomy.group, customGroup.name.toLowerCase());
    console.log(`   ✓ File "${assignDocRes.data.document.filename}" assigned to Group "${customGroup.name}".`);

    // 6. GET /api/groups/:id - Verify group contains BOTH the collection AND the document
    console.log('\n6️⃣ Inspecting Group detail & membership (GET /api/groups/:id)...');
    const groupDetailRes = await axios.get(`${API_BASE}/groups/${customGroup.id}`, authHeaders);
    const groupDetail = groupDetailRes.data.group;

    assert.strictEqual(groupDetail.collectionCount, 1, 'Group should contain 1 collection');
    assert.strictEqual(groupDetail.fileCount, 1, 'Group should contain 1 direct file');
    assert.strictEqual(groupDetail.collections[0].id, colId);
    assert.strictEqual(groupDetail.documents[0].id, docId);
    console.log(`   ✓ Group contains both member types: 1 Collection ("${groupDetail.collections[0].name}") & 1 File ("${groupDetail.documents[0].filename}").`);

    // 7. PATCH /api/groups/:id - Update & Rename Group with CASCADE
    console.log('\n7️⃣ Updating & Renaming Group (PATCH /api/groups/:id) with atomic cascade...');
    const updateGroupRes = await axios.patch(
      `${API_BASE}/groups/${customGroup.id}`,
      {
        name: 'Autonomous Agent Engineering',
        color: '#06b6d4',
      },
      authHeaders
    );
    assert.strictEqual(updateGroupRes.data.group.name, 'Autonomous Agent Engineering');
    console.log(`   ✓ Group renamed to: "${updateGroupRes.data.group.name}".`);

    // Verify cascade rename to collection and file
    const verifyCol = await axios.get(`${API_BASE}/collections/${colId}`, authHeaders);
    assert.strictEqual(verifyCol.data.collection.groupName, 'Autonomous Agent Engineering');
    const verifyDoc = await axios.get(`${API_BASE}/documents/${docId}`, authHeaders);
    assert.strictEqual(verifyDoc.data.metadata.taxonomy.group, 'autonomous agent engineering');
    console.log(`   ✓ Cascade verified: Collection & File automatically updated to new group name.`);

    // 8. Test Batch Assignment (POST /api/groups/batch-assign)
    console.log('\n8️⃣ Testing Batch Assignment (POST /api/groups/batch-assign)...');
    const batchRes = await axios.post(
      `${API_BASE}/groups/batch-assign`,
      {
        targetType: 'collection',
        targetIds: [colId],
        groupId: customGroup.id,
        groupName: 'Autonomous Agent Engineering',
      },
      authHeaders
    );
    assert.strictEqual(batchRes.data.success, true);
    console.log(`   ✓ Batch assignment completed: ${batchRes.data.modifiedCount} item(s) processed.`);

    // 9. DELETE /api/groups/:id - Delete group safely (disband without losing files)
    console.log('\n9️⃣ Deleting Group safely (DELETE /api/groups/:id)...');
    const delRes = await axios.delete(`${API_BASE}/groups/${customGroup.id}`, authHeaders);
    assert.strictEqual(delRes.status, 200);
    console.log(`   ✓ Group deleted: ${delRes.data.message}`);

    // Verify collection and file are preserved in General group
    const postDelCol = await axios.get(`${API_BASE}/collections/${colId}`, authHeaders);
    assert.strictEqual(postDelCol.data.collection.groupName, 'General');
    const postDelDoc = await axios.get(`${API_BASE}/documents/${docId}`, authHeaders);
    assert.strictEqual(postDelDoc.data.metadata.taxonomy.group, 'general');
    console.log(`   ✓ Safe disband verified: Collection & File preserved safely with groupName 'General'.`);

    console.log('\n🎉 ALL GROUP CRUD (FILE & COLLECTION) TESTS PASSED PERFECTLY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

runGroupCrudTest();

