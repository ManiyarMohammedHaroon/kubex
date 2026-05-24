/**
 * @file test_auth_scoping.js — Automated Integration Tests for Multi-Tenancy & Scoped RBAC.
 * Uses native fetch (supported in Node.js 18+) for zero dependencies.
 *
 * Tests cover:
 *  1. Unauthenticated access blocked (401)
 *  2. Developer A/B tenant isolation on /deployments
 *  3. Viewer scoping (sees only assigned deployments)
 *  4. Write operations blocked for viewers (403)
 *  5. GET /cluster/status blocked without token (401)
 *  6. GET /cluster/status returns only Developer A's deployment counts
 *  7. GET /cluster/status for Developer B returns 0 deployments (isolation)
 *  8. GET /nodes/events/list blocked without token (401)
 *  9. GET /nodes/events/list returns only scoped events for the logged-in user
 */
const mongoose = require('mongoose');
const User = require('./models/User');
const Deployment = require('./models/Deployment');

const API_URL = 'http://localhost:3001/api';
const MONGO_URI = 'mongodb://127.0.0.1:27017/kubex';

async function runTests() {
    console.log('🧪 Starting Automated Multi-Tenancy & Scoped Auth Tests...');
    
    // Connect to database directly for cleanup and direct inspection
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB for verification');

    // Clean up any old test users/deployments first
    await User.deleteMany({ email: /@test-kubex\.io$/i });
    await Deployment.deleteMany({ name: /^test-dep-/ });
    console.log('🧹 Cleaned up old test records');

    let passedTests = 0;
    let totalTests = 0;

    const assertEqual = (actual, expected, msg) => {
        totalTests++;
        if (actual === expected) {
            console.log(`✅ PASSED: ${msg}`);
            passedTests++;
        } else {
            console.error(`❌ FAILED: ${msg} | Expected "${expected}" but got "${actual}"`);
        }
    };

    try {
        // ─── Test 1: Access without token ──────────────────────────────────
        console.log('\n--- Test 1: Access Protected /deployments Without Token ---');
        const res1 = await fetch(`${API_URL}/deployments`);
        assertEqual(res1.status, 401, 'Access blocked with 401 Unauthorized');

        // ─── Test 1b: Access /cluster/status without token ─────────────────
        console.log('\n--- Test 1b: Access Protected /cluster/status Without Token ---');
        const res1b = await fetch(`${API_URL}/cluster/status`);
        assertEqual(res1b.status, 401, '/cluster/status blocked with 401 Unauthorized');

        // ─── Test 1c: Access /nodes/events/list without token ──────────────
        console.log('\n--- Test 1c: Access Protected /nodes/events/list Without Token ---');
        const res1c = await fetch(`${API_URL}/nodes/events/list`);
        assertEqual(res1c.status, 401, '/nodes/events/list blocked with 401 Unauthorized');

        // ─── Test 1d: Access /nodes without token ──────────────────────────
        console.log('\n--- Test 1d: Access Protected /nodes Without Token ---');
        const res1d = await fetch(`${API_URL}/nodes`);
        assertEqual(res1d.status, 401, '/nodes blocked with 401 Unauthorized');

        // ─── Test 2: Create Developer A ────────────────────────────────────
        console.log('\n--- Test 2: Sign Up Developer A ---');
        const devA_Res = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'dev_a',
                email: 'dev_a@test-kubex.io',
                password: 'password123',
                role: 'developer'
            })
        });
        const devA_Data = await devA_Res.json();
        assertEqual(devA_Res.status, 201, 'Sign up response status is 201 Created');
        
        const tokenA = devA_Data.token;
        const userA = devA_Data.user;
        assertEqual(userA.role, 'developer', 'Signed up as developer');
        assertEqual(userA.email, 'dev_a@test-kubex.io', 'Email is correct');

        // ─── Test 3: Create Developer B ────────────────────────────────────
        console.log('\n--- Test 3: Sign Up Developer B ---');
        const devB_Res = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'dev_b',
                email: 'dev_b@test-kubex.io',
                password: 'password123',
                role: 'developer'
            })
        });
        const devB_Data = await devB_Res.json();
        const tokenB = devB_Data.token;
        const userB = devB_Data.user;
        assertEqual(devB_Res.status, 201, 'Sign up Developer B response status is 201 Created');

        // ─── Test 4: Create Viewer A linked to Developer A ─────────────────
        console.log('\n--- Test 4: Sign Up Viewer A Linked to Developer A ---');
        const viewA_Res = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'viewer_a',
                email: 'viewer_a@test-kubex.io',
                password: 'password123',
                role: 'viewer',
                developerEmail: 'dev_a@test-kubex.io'
            })
        });
        const viewA_Data = await viewA_Res.json();
        assertEqual(viewA_Res.status, 201, 'Sign up Viewer A response status is 201 Created');
        
        const tokenViewA = viewA_Data.token;
        const userViewA = viewA_Data.user;
        assertEqual(userViewA.role, 'viewer', 'Signed up as viewer A');
        assertEqual(userViewA.tenantId, userA.tenantId, 'Linked to Developer A tenant');

        // ─── Test 5: Viewer with invalid developer email ────────────────────
        console.log('\n--- Test 5: Sign Up Viewer with Invalid Developer Link ---');
        const viewInvalid_Res = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'viewer_invalid',
                email: 'viewer_invalid@test-kubex.io',
                password: 'password123',
                role: 'viewer',
                developerEmail: 'doesnotexist@test-kubex.io'
            })
        });
        assertEqual(viewInvalid_Res.status, 404, 'Signup failed with 404 Developer not found');

        // ─── Test 6: Developer A creates deployment ─────────────────────────
        console.log('\n--- Test 6: Developer A Creates Deployment ---');
        const depRes = await fetch(`${API_URL}/deployments`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${tokenA}`
            },
            body: JSON.stringify({
                name: 'test-dep-a',
                desiredReplicas: 2,
                gitRepository: 'https://github.com/octocat/Spoon-Knife',
                gitBranch: 'main',
                dockerHubUsername: 'testuser',
                viewers: [userViewA._id]
            })
        });
        const depData = await depRes.json();
        if (depRes.status !== 201) {
            console.log('🔴 Response status is not 201. Full response body:', depData);
        }
        assertEqual(depRes.status, 201, 'Create deployment response status is 201 Created');
        
        const depA = depData.data ? (Array.isArray(depData.data) ? depData.data[0] : depData.data) : undefined;
        assertEqual(depA.name, 'test-dep-a', 'Created deployment test-dep-a');
        assertEqual(depA.owner, userA._id.toString(), 'Deployment owned by Developer A');

        // ─── Test 7: Developer A sees the deployment ────────────────────────
        console.log('\n--- Test 7: Developer A Fetches Deployments ---');
        const listA_Res = await fetch(`${API_URL}/deployments`, {
            headers: { 'Authorization': `Bearer ${tokenA}` }
        });
        const listA_Data = await listA_Res.json();
        const hasDepA = listA_Data.data.some(d => d.name === 'test-dep-a');
        assertEqual(hasDepA, true, 'Developer A sees their deployment');

        // ─── Test 8: Developer B does NOT see Developer A's deployment ───────
        console.log('\n--- Test 8: Developer B (Isolated Tenant) Fetches Deployments ---');
        const listB_Res = await fetch(`${API_URL}/deployments`, {
            headers: { 'Authorization': `Bearer ${tokenB}` }
        });
        const listB_Data = await listB_Res.json();
        const leakDepA = listB_Data.data.some(d => d.name === 'test-dep-a');
        assertEqual(leakDepA, false, 'Developer B cannot see Developer A\'s deployment (Strong Isolation)');

        // ─── Test 9: Viewer A sees Developer A's assigned deployment ─────────
        console.log('\n--- Test 9: Viewer A Fetches Assigned Deployments ---');
        const listViewA_Res = await fetch(`${API_URL}/deployments`, {
            headers: { 'Authorization': `Bearer ${tokenViewA}` }
        });
        const listViewA_Data = await listViewA_Res.json();
        const viewerSeesDepA = listViewA_Data.data.some(d => d.name === 'test-dep-a');
        assertEqual(viewerSeesDepA, true, 'Viewer A sees their assigned deployment');

        // ─── Test 10: Viewer A cannot scale (read-only) ─────────────────────
        console.log('\n--- Test 10: Viewer A Attempts Write Operation (Scale) ---');
        const scaleRes = await fetch(`${API_URL}/deployments/${depA._id}/scale`, {
            method: 'PUT',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${tokenViewA}`
            },
            body: JSON.stringify({ replicas: 5 })
        });
        assertEqual(scaleRes.status, 403, 'Scaling blocked with 403 Forbidden for Viewer');

        // ─── Test 11: Developer A creates Deployment B (no viewer access) ────
        console.log('\n--- Test 11: Developer A Creates Deployment B (No Viewer Access) ---');
        const depB_Res2 = await fetch(`${API_URL}/deployments`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${tokenA}`
            },
            body: JSON.stringify({
                name: 'test-dep-b',
                desiredReplicas: 1,
                gitRepository: 'https://github.com/octocat/Spoon-Knife',
                gitBranch: 'main',
                dockerHubUsername: 'testuser',
                viewers: []
            })
        });
        const depB_Data = await depB_Res2.json();
        if (depB_Res2.status !== 201) {
            console.log('🔴 Response status is not 201 for dep B. Full response body:', depB_Data);
        }
        assertEqual(depB_Res2.status, 201, 'Create deployment B response status is 201 Created');
        
        const depB = depB_Data.data ? (Array.isArray(depB_Data.data) ? depB_Data.data[0] : depB_Data.data) : undefined;
        assertEqual(depB.name, 'test-dep-b', 'Created deployment test-dep-b without assigned viewers');

        // ─── Test 12: Viewer A does NOT see Deployment B ─────────────────────
        console.log('\n--- Test 12: Viewer A Fetches Deployments (Granular Scope Check) ---');
        const listViewA_Res2 = await fetch(`${API_URL}/deployments`, {
            headers: { 'Authorization': `Bearer ${tokenViewA}` }
        });
        const listViewA_Data2 = await listViewA_Res2.json();
        const viewerSeesDepB = listViewA_Data2.data.some(d => d.name === 'test-dep-b');
        assertEqual(viewerSeesDepB, false, 'Viewer A cannot see test-dep-b (Perfect Granular Scoping)');

        // ─── Test 13: Developer A cluster/status shows scoped deployment count
        console.log('\n--- Test 13: Developer A Cluster Status Shows Own Deployment Count ---');
        const statusA_Res = await fetch(`${API_URL}/cluster/status`, {
            headers: { 'Authorization': `Bearer ${tokenA}` }
        });
        assertEqual(statusA_Res.status, 200, 'Developer A can access /cluster/status');
        const statusA_Data = await statusA_Res.json();
        // Developer A has test-dep-a and test-dep-b, so total should be 2
        assertEqual(statusA_Data.data.deployments.total, 2, 'Developer A sees exactly 2 deployments in cluster status');

        // ─── Test 14: Developer B cluster/status shows 0 deployments ─────────
        console.log('\n--- Test 14: Developer B Cluster Status Shows 0 Deployments (Isolation) ---');
        const statusB_Res = await fetch(`${API_URL}/cluster/status`, {
            headers: { 'Authorization': `Bearer ${tokenB}` }
        });
        assertEqual(statusB_Res.status, 200, 'Developer B can access /cluster/status');
        const statusB_Data = await statusB_Res.json();
        assertEqual(statusB_Data.data.deployments.total, 0, 'Developer B sees 0 deployments (isolated from Developer A)');

        // ─── Test 15: Viewer A cluster/status shows only their assigned deployment
        console.log('\n--- Test 15: Viewer A Cluster Status Shows Only Assigned Deployment ---');
        const statusViewA_Res = await fetch(`${API_URL}/cluster/status`, {
            headers: { 'Authorization': `Bearer ${tokenViewA}` }
        });
        assertEqual(statusViewA_Res.status, 200, 'Viewer A can access /cluster/status');
        const statusViewA_Data = await statusViewA_Res.json();
        // Viewer A is only assigned to test-dep-a (not test-dep-b)
        assertEqual(statusViewA_Data.data.deployments.total, 1, 'Viewer A sees exactly 1 deployment in cluster status');

        // ─── Test 16: Developer B's load balancer pool shows no other user pools
        console.log('\n--- Test 16: Developer B Load Balancer Shows No Other User Pools ---');
        const lbPoolKeys = Object.keys(statusB_Data.data.loadBalancer || {});
        assertEqual(lbPoolKeys.length, 0, 'Developer B has empty load balancer pool (no data leaks)');

        // ─── Test 17: Events list requires auth ───────────────────────────────
        console.log('\n--- Test 17: Events List Returns Only Scoped Events for Developer A ---');
        const eventsA_Res = await fetch(`${API_URL}/nodes/events/list`, {
            headers: { 'Authorization': `Bearer ${tokenA}` }
        });
        assertEqual(eventsA_Res.status, 200, 'Developer A can fetch events');
        const eventsA_Data = await eventsA_Res.json();
        // Check that no events from test-dep-b by another user leak through
        // (test-dep-b is owned by Developer A so it IS visible, but nothing from Developer B)
        const allDepEvents = eventsA_Data.data.filter(e => 
            e.involvedObject?.kind === 'Deployment' || e.involvedObject?.kind === 'Container'
        );
        const hasForeignEvent = allDepEvents.some(e => 
            e.involvedObject?.name && 
            !['test-dep-a', 'test-dep-b'].includes(e.involvedObject.name)
        );
        assertEqual(hasForeignEvent, false, 'No foreign deployment events leak into Developer A event feed');

        // ─── Test 18: Developer B events contain no events from Dev A's deployments
        console.log('\n--- Test 18: Developer B Events Show No Developer A Deployment Events ---');
        const eventsB_Res = await fetch(`${API_URL}/nodes/events/list`, {
            headers: { 'Authorization': `Bearer ${tokenB}` }
        });
        assertEqual(eventsB_Res.status, 200, 'Developer B can fetch events');
        const eventsB_Data = await eventsB_Res.json();
        const devBSeesDevAEvent = eventsB_Data.data.some(e => 
            (e.involvedObject?.kind === 'Deployment' || e.involvedObject?.kind === 'Container') &&
            (e.involvedObject?.name === 'test-dep-a' || e.involvedObject?.name === 'test-dep-b')
        );
        assertEqual(devBSeesDevAEvent, false, 'Developer B cannot see Developer A deployment events (Scoped event feed)');

        // ─── Test 19: Viewer A cannot delete nodes ────────────────────────────
        console.log('\n--- Test 19: Viewer A Cannot Delete a Node (403 Forbidden) ---');
        const deleteNodeRes = await fetch(`${API_URL}/nodes/fake-node-xyz`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${tokenViewA}` }
        });
        assertEqual(deleteNodeRes.status, 403, 'Viewer blocked from deleting nodes with 403 Forbidden');

    } catch (err) {
        console.error('❌ Fatal error in integration test runner:', err.message);
    } finally {
        // Clean up database
        await User.deleteMany({ email: /@test-kubex\.io$/i });
        await Deployment.deleteMany({ name: /^test-dep-/ });
        console.log('\n🧹 Database cleaned up');
        
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB.');
        console.log(`\n🎉 Test Run Complete: ${passedTests}/${totalTests} tests passed!`);
    }
}

runTests();
