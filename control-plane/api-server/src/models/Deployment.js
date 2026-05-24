/**
 * @file Deployment.js — Mongoose model for a KUBEX Deployment.
 *
 * A Deployment describes a desired state: "run N replicas of Docker image X
 * with these resource limits and environment variables."
 *
 * The Reconciler reads Deployments every few seconds and reconciles the
 * actual Docker container state with what is stored here.
 *
 * The AutoScaler also reads Deployments (when autoscalingEnabled === true)
 * and adjusts desiredReplicas within [minReplicas, maxReplicas].
 */
const mongoose = require('mongoose');

/**
 * Sub-schema for a single running container instance within a Deployment.
 * The Reconciler populates this list after creating containers via Docker.
 */
const containerSchema = new mongoose.Schema({
    containerId: { type: String, required: true },   // Full Docker container ID (64 chars)
    nodeId: { type: String, default: 'local' }, // Which worker node is running this container
    status: {
        type: String,
        enum: ['running', 'stopped', 'exited', 'unknown'],
        default: 'running',
    },
    startedAt: { type: Date, default: Date.now },    // When the container was created
    ip: { type: String, default: '' },        // Container's internal Docker network IP
    hostPort: { type: String, default: '' },        // Host port mapped to container port 80 (random, assigned by Docker)
});

/**
 * Main schema for a Deployment resource.
 *
 * Lifecycle: Pending → Running | Degraded | Scaling → Terminating
 */
const deploymentSchema = new mongoose.Schema(
    {
        // Unique human-readable name for this deployment (e.g. "my-nginx")
        name: { type: String, required: true, unique: true, trim: true },

        // Docker image to run (e.g. "nginx:alpine", "my-registry/app:latest")
        image: { type: String, required: true },

        // How many container replicas the user wants running at all times
        desiredReplicas: { type: Number, required: true, min: 0, max: 20, default: 1 },

        // How many replicas are actually running right now (maintained by Reconciler)
        actualReplicas: { type: Number, default: 0 },

        // Per-container resource caps applied via Docker's HostConfig
        resourceLimits: {
            cpu: { type: String, default: '0.5' },   // CPU fraction — 0.5 means half a core (NanoCpus = val * 1e9)
            memory: { type: String, default: '128m' },  // Memory limit, e.g. "128m", "512m", "1g"
        },

        // Environment variables injected into each container at start time
        // Stored as an array of { key, value } pairs and converted to "KEY=VALUE" strings
        envVars: [{ key: String, value: String }],

        // OPTIONAL: Specify a fixed host port to map to container port.
        // If provided, the FIRST replica will attempt to bind to this port.
        staticHostPort: { type: String, default: '' },

        // The port the app is listening on INSIDE the container (default: 80)
        containerPort: { type: Number, default: 80, min: 1, max: 65535 },

        // Application Health Checks
        healthCheck: {
            enabled: { type: Boolean, default: false },
            path: { type: String, default: '/health' },
            maxRetries: { type: Number, default: 3 }
        },

        // The path to the source folder if this was deployed from a local folder
        folderPath: { type: String, default: '' },

        // Current lifecycle status (updated by Reconciler and AutoScaler)
        status: {
            type: String,
            enum: ['Pending', 'Running', 'Degraded', 'Scaling', 'Terminating', 'Failed', 'Building'],
            default: 'Pending',
        },

        // Live list of containers currently managed for this deployment
        containers: [containerSchema],

        // ── Autoscaling fields ────────────────────────────────────────────────
        minReplicas: { type: Number, default: 1 },    // AutoScaler will never go below this
        maxReplicas: { type: Number, default: 10 },   // AutoScaler will never go above this
        autoscalingEnabled: { type: Boolean, default: false }, // Toggle HPA-style scaling on/off
        cpuThresholdUp: { type: Number, default: 80 },   // Scale UP  if avg CPU% exceeds this
        cpuThresholdDown: { type: Number, default: 20 },   // Scale DOWN if avg CPU% drops below this

        // Multi-tenant isolation & access control
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        viewers: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }],

        // GitHub Integration
        gitRepository: { type: String, default: '' },
        gitBranch: { type: String, default: 'main' },
        gitToken: { type: String, default: '' },
        webhookSecret: { type: String, default: '' },
        autoDeploy: { type: Boolean, default: true },
        gitSubfolder: { type: String, default: '' },
        dockerHubUsername: { type: String, default: '' }
    },
    { timestamps: true } // Adds createdAt and updatedAt fields automatically
);

module.exports = mongoose.model('Deployment', deploymentSchema);
