/**
 * @file test_git_webhook.js — Automated Integration Tests for Phase 2: Git Builds & Webhook Security.
 * Uses native fetch (supported in Node.js 18+) for zero dependencies.
 */
const mongoose = require('mongoose');
const User = require('./models/User');
const Deployment = require('./models/Deployment');

const API_URL = 'http://127.0.0.1:3001/api';
const MONGO_URI = 'mongodb://127.0.0.1:27017/kubex';

async function runTests() {
    console.log('🧪 Starting Automated Phase 2: Git Builds & Webhook Security Tests...');
    
    // Connect to database directly for cleanup and direct inspection
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB for verification');

    // Clean up any old test users/deployments first
    await User.deleteMany({ email: /@test-git-kubex\.io$/i });
    await Deployment.deleteMany({ name: /^test-git-dep/ });
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
        // Step 1: Sign up Developer
        console.log('\n--- Step 1: Sign Up Developer ---');
        const devRes = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'dev_git',
                email: 'dev_git@test-git-kubex.io',
                password: 'password123',
                role: 'developer'
            })
        });
        const devData = await devRes.json();
        assertEqual(devRes.status, 201, 'Developer signed up successfully');
        const tokenDev = devData.token;
        const userDev = devData.user;

        // Step 2: Sign up Viewer linked to Developer
        console.log('\n--- Step 2: Sign Up Viewer Linked to Developer ---');
        const viewRes = await fetch(`${API_URL}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'viewer_git',
                email: 'viewer_git@test-git-kubex.io',
                password: 'password123',
                role: 'viewer',
                developerEmail: 'dev_git@test-git-kubex.io'
            })
        });
        const viewData = await viewRes.json();
        assertEqual(viewRes.status, 201, 'Viewer signed up successfully');
        const tokenView = viewData.token;
        const userView = viewData.user;

        // Step 3: Create Git Deployment (Developer)
        console.log('\n--- Step 3: Developer Creates Git Deployment ---');
        const depRes = await fetch(`${API_URL}/deployments`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${tokenDev}`
            },
            body: JSON.stringify({
                name: 'test-git-dep',
                desiredReplicas: 1,
                gitRepository: 'https://github.com/octocat/Spoon-Knife',
                gitBranch: 'main',
                dockerHubUsername: 'testuser',
                autoDeploy: true,
                viewers: [userView._id]
            })
        });
        const depData = await depRes.json();
        assertEqual(depRes.status, 201, 'Git deployment created with 201 Created');
        const dep = depData.data;
        assertEqual(dep.status, 'Building', 'Initial deployment status is "Building"');
        assertEqual(!!dep.webhookSecret, true, 'Deployment has a webhookSecret generated');
        const secret = dep.webhookSecret;

        // Step 4: Webhook Security Verification
        console.log('\n--- Step 4: Webhook Security Verification ---');
        
        // 4a. Invalid token
        console.log('Sending webhook with invalid token...');
        const badWebhookRes = await fetch(`${API_URL}/webhooks/github/${dep._id}?token=invalid-secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'refs/heads/main' })
        });
        assertEqual(badWebhookRes.status, 401, 'Webhook request with invalid token blocked with 401 Unauthorized');

        // 4b. Missing token
        console.log('Sending webhook with missing token...');
        const missingWebhookRes = await fetch(`${API_URL}/webhooks/github/${dep._id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'refs/heads/main' })
        });
        assertEqual(missingWebhookRes.status, 401, 'Webhook request without token blocked with 401 Unauthorized');

        // 4c. Valid token, wrong branch push
        console.log('Sending webhook with valid token but different branch...');
        const wrongBranchRes = await fetch(`${API_URL}/webhooks/github/${dep._id}?token=${secret}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'refs/heads/develop' })
        });
        const wrongBranchData = await wrongBranchRes.json();
        assertEqual(wrongBranchRes.status, 200, 'Webhook accepted');
        assertEqual(wrongBranchData.message.includes('Skipping build'), true, 'Build skipped because branch ref mismatched');

        // 4d. Valid token, correct branch push
        console.log('Sending webhook with valid token and matching branch...');
        const goodWebhookRes = await fetch(`${API_URL}/webhooks/github/${dep._id}?token=${secret}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ref: 'refs/heads/main' })
        });
        const goodWebhookData = await goodWebhookRes.json();
        assertEqual(goodWebhookRes.status, 200, 'Webhook accepted and triggered rebuild successfully');
        assertEqual(goodWebhookData.success, true, 'Webhook success status is true');

        // Step 5: Read-Only Scoped Permissions for Viewer
        console.log('\n--- Step 5: Read-Only Scoped Permissions for Viewer ---');

        // 5a. Viewer fetches build logs
        console.log('Viewer fetches build logs...');
        const viewerLogsRes = await fetch(`${API_URL}/deployments/${dep._id}/build-logs`, {
            headers: { 'Authorization': `Bearer ${tokenView}` }
        });
        const viewerLogsData = await viewerLogsRes.json();
        assertEqual(viewerLogsRes.status, 200, 'Viewer can fetch build logs successfully');
        assertEqual(viewerLogsData.success, true, 'Viewer build logs payload has success = true');

        // 5b. Viewer tries to trigger redeployment
        console.log('Viewer tries to redeploy...');
        const viewerRedeployRes = await fetch(`${API_URL}/deployments/${dep._id}/redeploy`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tokenView}` }
        });
        assertEqual(viewerRedeployRes.status, 403, 'Redeploy blocked with 403 Forbidden for Viewer');

        // Step 6: Verify Build Log Contents
        console.log('\n--- Step 6: Verify Build Log Contents ---');
        console.log('Polling build logs for progress (up to 15 seconds)...');
        let logsFetched = false;
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const logsRes = await fetch(`${API_URL}/deployments/${dep._id}/build-logs`, {
                headers: { 'Authorization': `Bearer ${tokenDev}` }
            });
            const logsData = await logsRes.json();
            if (logsData.success && logsData.logs && logsData.logs.includes('KUBEX Git Build')) {
                console.log('Found build logs content:');
                console.log(logsData.logs.split('\n').slice(0, 10).join('\n'));
                logsFetched = true;
                break;
            }
        }
        assertEqual(logsFetched, true, 'Successfully fetched active streamed build logs');

    } catch (err) {
        console.error('❌ Fatal error in integration test runner:', err.message);
    } finally {
        // Clean up database
        await User.deleteMany({ email: /@test-git-kubex\.io$/i });
        await Deployment.deleteMany({ name: /^test-git-dep/ });
        console.log('\n🧹 Database cleaned up');
        
        await mongoose.disconnect();
        console.log('🔌 Disconnected from MongoDB.');
        console.log(`\n🎉 Test Run Complete: ${passedTests}/${totalTests} tests passed!`);
    }
}

runTests();
