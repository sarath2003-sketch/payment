import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle response errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth
export const auth = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  verify: () => api.get('/auth/verify'),
  logout: () => api.post('/auth/logout'),
};

// Members
export const members = {
  getAll: () => api.get('/members'),
  getById: (id) => api.get(`/members/${id}`),
  create: (data) => api.post('/members', data),
  update: (id, data) => api.put(`/members/${id}`, data),
  delete: (id) => api.delete(`/members/${id}`),
};

// Payments
export const payments = {
  getAll: (params) => api.get('/payments', { params }),
  getById: (id) => api.get(`/payments/${id}`),
  create: (data) => api.post('/payments', data),
  update: (id, data) => api.put(`/payments/${id}`, data),
  delete: (id) => api.delete(`/payments/${id}`),
};

// Withdrawals
export const withdrawals = {
  getAll: (params) => api.get('/withdrawals', { params }),
  getById: (id) => api.get(`/withdrawals/${id}`),
  create: (data) => api.post('/withdrawals', data),
  update: (id, data) => api.put(`/withdrawals/${id}`, data),
  delete: (id) => api.delete(`/withdrawals/${id}`),
};

// Transactions
export const transactions = {
  getAll: (params) => api.get('/transactions', { params }),
  getById: (id) => api.get(`/transactions/${id}`),
  getMonthlySummary: () => api.get('/transactions/summary/monthly'),
  getMemberSummary: (memberId) => api.get(`/transactions/member/${memberId}/summary`),
};

// Dashboard
export const dashboard = {
  getSummary: () => api.get('/dashboard/summary'),
  getMonthlyCollection: () => api.get('/dashboard/monthly-collection'),
  getMemberStats: () => api.get('/dashboard/member-stats'),
  getMonthlyReport: (month) => api.get(`/dashboard/monthly-report/${month}`),
};

// Import/Export
export const importExport = {
  import: (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/import-export/import', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
  exportMembers: () => api.get('/import-export/export/members', { responseType: 'blob' }),
  exportPayments: () => api.get('/import-export/export/payments', { responseType: 'blob' }),
  exportWithdrawals: () => api.get('/import-export/export/withdrawals', { responseType: 'blob' }),
  exportTransactions: () => api.get('/import-export/export/transactions', { responseType: 'blob' }),
  exportCompleteReport: () => api.get('/import-export/export/complete-report', { responseType: 'blob' }),
};

export default api;
