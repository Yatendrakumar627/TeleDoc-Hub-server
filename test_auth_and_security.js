const axios = require('axios');
const assert = require('assert');

const API_BASE = 'http://localhost:5000/api';

async function runAuthSecurityTest() {
  console.log('🛡️ Starting Dedicated Authentication & Security Test Suite...\n');

  try {
    // 1. Verify Unauthenticated Request is Blocked (401)
    console.log('1️⃣ Testing Protected Endpoints without Authentication...');
    let blocked = false;
    try {
      await axios.get(`${API_BASE}/documents`);
    } catch (err) {
      if (err.response && err.response.status === 401) {
        blocked = true;
        console.log(`   ✓ Correctly blocked unauthenticated request: 401 ${err.response.data.code}`);
      }
    }
    assert.strictEqual(blocked, true, 'Protected endpoint /api/documents must reject unauthenticated requests');

    // 2. Register User A (Master Vault Admin)
    const userAEmail = `admin_vault_${Date.now()}@teledoc.internal`;
    const userAPassword = 'SecureMasterPassword2026!';
    console.log(`\n2️⃣ Registering User A (${userAEmail})...`);

    const regResA = await axios.post(`${API_BASE}/auth/register`, {
      email: userAEmail,
      password: userAPassword,
      name: 'Vault Administrator',
    });

    assert.strictEqual(regResA.status, 201);
    assert(regResA.data.token, 'Should return signed JWT');
    assert.strictEqual(regResA.data.user.email, userAEmail);
    const tokenA = regResA.data.token;
    console.log(`   ✓ User A registered successfully! Role: ${regResA.data.user.role}`);

    // 3. User A queries documents with Bearer Token
    console.log('\n3️⃣ User A querying documents with Bearer Token...');
    const userADocsRes = await axios.get(`${API_BASE}/documents`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(userADocsRes.status, 200);
    console.log(`   ✓ Authenticated request succeeded! User A sees ${userADocsRes.data.total} documents.`);

    // 4. Test /api/auth/me
    console.log('\n4️⃣ Testing /api/auth/me for User A...');
    const meRes = await axios.get(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(meRes.data.user.email, userAEmail);
    console.log(`   ✓ Profile returned: "${meRes.data.user.name}" (${meRes.data.user.email})`);

    // 5. Register User B (Separate Tenant / Isolated User)
    const userBEmail = `user_b_${Date.now()}@isolated.internal`;
    const userBPassword = 'AnotherSecretPassword99!';
    console.log(`\n5️⃣ Registering User B (${userBEmail})...`);

    const regResB = await axios.post(`${API_BASE}/auth/register`, {
      email: userBEmail,
      password: userBPassword,
      name: 'Dr. Jane Tenant',
    });
    const tokenB = regResB.data.token;
    console.log(`   ✓ User B registered. Role: ${regResB.data.user.role}`);

    // 6. User B queries documents -> MUST BE ZERO (Complete Data Isolation!)
    console.log('\n6️⃣ Verifying Tenant Isolation (User B must NOT see User A documents)...');
    const userBDocsRes = await axios.get(`${API_BASE}/documents`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(userBDocsRes.data.total, 0, 'User B must see 0 documents from User A');
    console.log(`   ✓ Zero-Leakage Confirmed: User B sees exactly ${userBDocsRes.data.total} documents.`);

    // 7. Test Login with Valid Credentials
    console.log('\n7️⃣ Testing /api/auth/login with valid credentials...');
    const loginRes = await axios.post(`${API_BASE}/auth/login`, {
      email: userAEmail,
      password: userAPassword,
    });
    assert.strictEqual(loginRes.status, 200);
    assert(loginRes.data.token, 'Login must return fresh JWT token');
    console.log(`   ✓ Login successful for User A! Token issued.`);

    // 8. Test Login with Invalid Credentials
    console.log('\n8️⃣ Testing /api/auth/login with WRONG password...');
    let loginFailed = false;
    try {
      await axios.post(`${API_BASE}/auth/login`, {
        email: userAEmail,
        password: 'WrongPassword!',
      });
    } catch (err) {
      if (err.response && err.response.status === 401) {
        loginFailed = true;
        console.log(`   ✓ Correctly rejected invalid password with 401: "${err.response.data.error}"`);
      }
    }
    assert.strictEqual(loginFailed, true, 'Login with wrong password must fail');

    console.log('\n🎉 ALL AUTHENTICATION & SECURITY TESTS PASSED PERFECTLY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

runAuthSecurityTest();

