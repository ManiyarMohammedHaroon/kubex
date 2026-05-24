/**
 * @file Event.js — Mongoose model for KUBEX cluster events.
 *
 * Events are append-only audit records written by every service when
 * something noteworthy happens (container created, node failed, scaled up, etc.).
 * They are analogous to Kubernetes Events.
 *
 * Events are surfaced in the frontend's "Recent Events" feed and can be
 * fetched via GET /api/nodes/events/list (returns the last 100 events,
 * sorted newest-first).
 *
 * Services that create events:
 *   - ReconcilerService   → ContainerCreated, ContainerRemoved, ContainerCrashed
 *   - AutoScalerService   → ScaleUp, ScaleDown
 *   - FailureDetector     → NodeNotReady, NodeRecovered, ContainerRescheduled
 *   - deployments route   → DeploymentCreated, DeploymentDeleted, ManualScale
 */
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
    {
        // Severity level — determines how the event is styled in the UI
        //   Normal  — routine operation (green / info)
        //   Warning — something unexpected but recoverable (yellow)
        //   Error   — operation failed (red)
        type: { type: String, enum: ['Normal', 'Warning', 'Error'], default: 'Normal' },

        // Short machine-readable reason code (e.g. "ContainerCrashed", "ScaleUp")
        reason: { type: String, required: true },

        // Human-readable description of what happened
        message: { type: String, required: true },

        // The KUBEX resource this event relates to
        involvedObject: {
            kind: { type: String, enum: ['Deployment', 'Node', 'Container', 'System'] },
            name: { type: String }, // Name of the involved deployment/node/etc.
        },
    },
    { timestamps: true } // createdAt is used to sort events newest-first
);

// TTL Index: Automatically delete events older than 24 hours to prevent unbounded database growth
eventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('Event', eventSchema);
