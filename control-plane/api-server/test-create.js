const mongoose = require('mongoose');
const Deployment = require('./src/models/Deployment');
const Node = require('./src/models/Node');

async function run() {
    await mongoose.connect('mongodb://127.0.0.1:27017/kubex');
    console.log('Connected to DB');

    // Clean old deployments
    await Deployment.deleteMany({});
    console.log('Cleaned old deployments');

    await Node.create({
        nodeId: 'worker-1-d95d',
        status: 'Ready',
        address: 'http://localhost:4001',
        token: '797e9bd139a48c6f27a16adccd04243e09405391a3cbbee1637ea375e27cf2ff'
    });
    console.log('Provisioned node worker-1-d95d');

    // Create a mock user ID for isolation testing
    const mockUserId = new mongoose.Types.ObjectId();

    const dep = await Deployment.create({
        name: 'test-nginx-app',
        image: 'nginx:alpine',
        desiredReplicas: 1,
        owner: mockUserId, // This is the Namespace ID!
        status: 'Pending',
        containerPort: 80,
    });

    console.log(`Created deployment ${dep.name} for owner ${mockUserId}`);
    process.exit(0);
}

run().catch(console.error);
