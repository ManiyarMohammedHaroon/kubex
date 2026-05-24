const fs = require('fs');
const { execSync } = require('child_process');

fs.writeFileSync('test.js', "const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';\nconst res = await axios.post(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/auth/register`, formData);");

// Run sed command
try {
    execSync(`sed -i -E "s/import\\\\.meta\\\\.env\\\\.VITE_API_URL[[:space:]]*\\\\|\\\\|[[:space:]]*[\\'\\"]http:\\/\\/localhost:[0-9]+[\\'\\"]/\\'\\'/g" test.js`);
    console.log('Result:');
    console.log(fs.readFileSync('test.js', 'utf8'));
} catch (e) {
    console.error(e.message);
}
