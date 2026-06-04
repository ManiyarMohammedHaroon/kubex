const mongoose = require('mongoose');
const Node = require('./src/models/Node');

async function run() {
    await mongoose.connect('mongodb://127.0.0.1:27017/kubex');
    
    // Check if it already exists
    const existing = await Node.findOne({ nodeId: 'worker-1-d95d' });
    if (!existing) {
        await Node.create({
            nodeId: 'worker-1-d95d',
            status: 'Ready',
            address: 'http://localhost:4001',
            token: '797e9bd139a48c6f27a16adccd04243e09405391a3cbbee1637ea375e27cf2ff'
        });
        console.log('Worker node provisioned successfully!');
    } else {
        console.log('Worker node already exists!');
    }
    process.exit(0);
}
run();
