/**
 * @file api/client.js — Centralised Axios API client for all KUBEX API calls.
 *
 * All functions here return an Axios response promise.
 * Components call these functions directly rather than using fetch() or
 * creating their own Axios instances — this keeps the base URL and timeout
 * configuration in one place.
 *
 * Base URL: VITE_API_URL env var, defaults to http://localhost:3001/api
 * Timeout:  8 000 ms (avoids UI hangs if the API server is slow to respond)
 *
 * ── Why separate functions per call? ─────────────────────────────────────────
 * Named exports make refactoring easy: if an endpoint URL changes you only
 * edit this file, not every component that calls it.
 */
import axios from 'axios';

// Shared Axios instance used by all API calls in this application
const API = axios.create({
    baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001/api',
    timeout: 60000, // 60s timeout to accommodate Render's free tier 50s cold start
});

// Request interceptor: Automatically attach JWT token to all API requests
API.interceptors.request.use((config) => {
    const token = localStorage.getItem('kubex_token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
}, (error) => {
    return Promise.reject(error);
});

// Response interceptor: Catch 401 Unauthorized globally and clear the session
API.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response && error.response.status === 401) {
            localStorage.removeItem('kubex_token');
            localStorage.removeItem('kubex_user');
            if (window.location.pathname !== '/login' && window.location.pathname !== '/signup') {
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

// ─── Authentication ───────────────────────────────────────────────────────────

/** POST /auth/signup — Create a new developer or viewer account */
export const signup = (data) => API.post('/auth/signup', data);

/** POST /auth/login — Authenticate credentials and retrieve JWT token */
export const login = (data) => API.post('/auth/login', data);

/** GET /auth/me — Retrieve current session profile */
export const getMe = () => API.get('/auth/me');

// ─── Cluster ──────────────────────────────────────────────────────────────────
// These endpoints power the Dashboard page's real-time polling loop

/** GET /cluster/status — aggregated snapshot of the entire cluster */
export const getClusterStatus = () => API.get('/cluster/status');

/** GET /cluster/scheduler — node scores used by the Scheduler (for debugging placement) */
export const getScheduler = () => API.get('/cluster/scheduler');

// ─── Deployments ──────────────────────────────────────────────────────────────
// Full CRUD plus scale and patch (autoscaling config) operations

/** GET /deployments — list all deployments, sorted newest-first */
export const getDeployments = () => API.get('/deployments');

/** GET /deployments/:id — fetch a single deployment document */
export const getDeployment = (id) => API.get(`/deployments/${id}`);

/** POST /deployments — create a new deployment (triggers immediate reconciliation) */
export const createDeployment = (data) => API.post('/deployments', data);

/** POST /deployments/:id/redeploy — trigger background build and rolling update */
export const redeployDeployment = (id) => API.post(`/deployments/${id}/redeploy`);

/** GET /deployments/:id/build-logs — retrieve Git checkout and Docker build logs */
export const getBuildLogs = (id) => API.get(`/deployments/${id}/build-logs`);

/**
 * PUT /deployments/:id/scale — manually set the replica count.
 * The API server will cap it at the deployment's maxReplicas.
 */
export const scaleDeployment = (id, replicas) => API.put(`/deployments/${id}/scale`, { replicas });

/**
 * PATCH /deployments/:id — update autoscaling configuration only.
 * Allowed fields: autoscalingEnabled, minReplicas, maxReplicas, cpuThresholdUp, cpuThresholdDown
 */
export const patchDeployment = (id, data) => API.patch(`/deployments/${id}`, data);

/** POST /deployments/:id/domains — add a custom domain */
export const addCustomDomain = (id, domain) => API.post(`/deployments/${id}/domains`, { domain });

/** DELETE /deployments/:id/domains/:domain — remove a custom domain */
export const removeCustomDomain = (id, domain) => API.delete(`/deployments/${id}/domains/${domain}`);

/** DELETE /deployments/:id — terminate a deployment and remove all its containers */
export const deleteDeployment = (id) => API.delete(`/deployments/${id}`);
export const updateEnvVars = (id, envVars) => API.put(`/deployments/${id}/env`, { envVars });
export const rebalanceDeployment = (id) => API.post(`/deployments/${id}/rebalance`);

/** POST /deployments/:id/share — Share deployment with a client email */
export const shareDeployment = (id, email) => API.post(`/deployments/${id}/share`, { email });

/** DELETE /deployments/:id/share/:userId — Revoke client access */
export const revokeDeploymentAccess = (id, userId) => API.delete(`/deployments/${id}/share/${userId}`);

// ─── Nodes ────────────────────────────────────────────────────────────────────

/** GET /nodes — list all registered worker nodes */
export const getNodes = () => API.get('/nodes');

/** GET /nodes/:nodeId — get node details plus enriched container list */
export const getNodeDetail = (nodeId) => API.get(`/nodes/${nodeId}`);

/** GET /nodes/:nodeId/logs — get worker agent internal logs */
export const getNodeLogs = (nodeId) => API.get(`/nodes/${nodeId}/logs`);

/** GET /nodes/events/list — last 100 cluster events, newest first */
export const getEvents = () => API.get('/nodes/events/list');

/** DELETE /nodes/:nodeId — manually remove a node entry from the database */
export const deleteNode = (nodeId) => API.delete(`/nodes/${nodeId}`);

// ─── Chaos Engineering ────────────────────────────────────────────────────────
// These calls go DIRECTLY to the worker agent's HTTP address (bypass the API server)
// because they need to reach the agent even if the control plane is unreachable.

/**
 * POST <nodeUrl>/chaos/stress — spike the node's reported CPU to `cpu`% for 30 s.
 * Triggers the AutoScaler to scale up the deployment on this node.
 *
 * @param {string} nodeUrl  Worker agent address, e.g. "http://localhost:4001"
 * @param {number} cpu      CPU percentage to simulate (e.g. 95)
 */
export const triggerStress = (nodeUrl, cpu) => axios.post(`${nodeUrl}/chaos/stress`, { cpu });

/**
 * POST <nodeUrl>/chaos/kill — randomly stop one KUBEX container on this node.
 * Tests the Reconciler's self-healing: it should recreate the container within ~5 s.
 *
 * @param {string} nodeUrl  Worker agent address, e.g. "http://localhost:4001"
 */
export const triggerChaosKill = (nodeUrl) => axios.post(`${nodeUrl}/chaos/kill`);

// ─── Logs ─────────────────────────────────────────────────────────────────────

/**
 * GET /logs/:deploymentId — fetch the last 200 log lines from all containers
 * of the given deployment. Response contains the deployment name and an array
 * of { containerId, nodeId, logs }.
 */
export const getLogs = (id) => API.get(`/logs/${id}`);

/** POST /logs/:deploymentId/:containerId/analyze — Send logs to AI for debugging */
export const analyzeLogs = (deploymentId, containerId, logs) => 
    API.post(`/logs/${deploymentId}/${containerId}/analyze`, { logs });

// ─── Workers ──────────────────────────────────────────────────────────────────

/** POST /workers/provision — triggers the API server to spawn a new worker process locally */
export const provisionWorker = (type = 'local') => API.post('/workers/provision', { type });
export const spawnWorker = provisionWorker;

/** GET /system/images — list all local docker images */
export const getImages = () => API.get('/system/images');

/** DELETE /system/images/:id — delete a specific image */
export const deleteImage = (id) => API.delete(`/system/images/${id}`, { timeout: 60000 });

/** POST /system/images/prune — remove all unused images */
export const pruneImages = () => API.post('/system/images/prune', { timeout: 60000 });

// ─── Databases (DBaaS) ────────────────────────────────────────────────────────

/** GET /databases — list all databases */
export const getDatabases = () => API.get('/databases');

/** POST /databases — create a new managed database */
export const createDatabase = (data) => API.post('/databases', data);

/** DELETE /databases/:id — terminate a managed database */
export const deleteDatabase = (id) => API.delete(`/databases/${id}`);

/** POST /databases/:id/share — Share database with a client email */
export const shareDatabase = (id, email) => API.post(`/databases/${id}/share`, { email });

/** DELETE /databases/:id/share/:userId — Revoke client access */
export const revokeDatabaseAccess = (id, userId) => API.delete(`/databases/${id}/share/${userId}`);

export default API;
