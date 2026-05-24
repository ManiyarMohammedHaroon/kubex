require('dotenv').config();
const jwt = require('jsonwebtoken');
const axios = require('axios');

async function trigger() {
    const token = jwt.sign({ id: '6a0eed816c57db7ef01c99e1', role: 'admin' }, process.env.JWT_SECRET);
    try {
        const res = await axios.post('http://127.0.0.1:3001/api/deployments/6a10b2099885c4cf6503d9dd/redeploy', {}, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(res.data);
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
    }
}
trigger().then(() => process.exit());
