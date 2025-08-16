import axios from 'axios';

// Set the backend base URL (hardcoded for production)
axios.defaults.baseURL = '';

// Automatically attach the token if available
axios.interceptors.request.use(config => {
  const user = JSON.parse(localStorage.getItem('user'));
  if (user?.token) {
    config.headers.Authorization = `Bearer ${user.token}`;
  }
  return config;
});

// Log all responses and errors clearly for debugging
axios.interceptors.response.use(
  response => response,
  error => {
    console.error('❌ Axios Error:', {
      message: error.message,
      url: error.config?.url,
      method: error.config?.method,
      status: error.response?.status,
      data: error.response?.data,
    });
    return Promise.reject(error);
  }
);

export default axios;