const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const res = await axios.post(`${import.meta.env.VITE_API_URL || 'http://localhost:5000'}/api/auth/register`, formData);