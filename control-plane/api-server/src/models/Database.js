const mongoose = require('mongoose');

const databaseSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, unique: true, trim: true },
        type: { 
            type: String, 
            enum: ['mongo', 'postgres', 'mysql', 'redis'], 
            required: true 
        },
        status: {
            type: String,
            enum: ['Pending', 'Running', 'Failed', 'Terminating'],
            default: 'Pending',
        },
        credentials: {
            username: { type: String, required: true },
            password: { type: String, required: true }
        },
        containerId: { type: String, default: '' },
        volumeName: { type: String, default: '' },
        internalPort: { type: Number, required: true },
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        viewers: [{
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }]
    },
    { timestamps: true }
);

// Virtual for the connection string
databaseSchema.virtual('connectionString').get(function() {
    const host = `kubex-db-${this._id}`;
    const user = encodeURIComponent(this.credentials.username);
    const pass = encodeURIComponent(this.credentials.password);
    
    switch (this.type) {
        case 'mongo':
            return `mongodb://${user}:${pass}@${host}:${this.internalPort}/admin`;
        case 'postgres':
            return `postgresql://${user}:${pass}@${host}:${this.internalPort}/kubexdb`;
        case 'mysql':
            return `mysql://${user}:${pass}@${host}:${this.internalPort}/kubexdb`;
        case 'redis':
            return `redis://default:${pass}@${host}:${this.internalPort}`;
        default:
            return '';
    }
});

// Ensure virtuals are included in JSON/Object conversions
databaseSchema.set('toJSON', { virtuals: true });
databaseSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Database', databaseSchema);
