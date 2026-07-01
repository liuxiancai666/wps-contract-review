import { ref, computed } from 'vue';
import { setUserId } from '../user';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

// 全局单例状态
const authUser = ref(loadUser());
const authToken = ref(loadToken());

function loadToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function loadUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persist(token, user) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);

  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

export function useAuth() {
  const isLoggedIn = computed(() => !!authToken.value && !!authUser.value);
  const isAdmin = computed(() => authUser.value?.role === 'admin');

  const apiBase = import.meta.env.VITE_APP_BACKEND_API_URL || '';

  async function login(username, password) {
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '登录失败');

    authToken.value = data.token;
    authUser.value = { id: data.id, username: data.username, role: data.role };
    setUserId(data.id); // 确保 API 请求头携带正确的 X-User-ID
    persist(data.token, authUser.value);
    return data;
  }

  async function register(username, password) {
    const res = await fetch(`${apiBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '注册失败');

    authToken.value = data.token;
    authUser.value = { id: data.id, username: data.username, role: data.role };
    setUserId(data.id); // 确保 API 请求头携带正确的 X-User-ID
    persist(data.token, authUser.value);
    return data;
  }

  function logout() {
    authToken.value = null;
    authUser.value = null;
    localStorage.removeItem('user_id'); // 清除 API 用户标识
    persist(null, null);
  }

  function getAuthHeaders() {
    const token = authToken.value;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  return {
    authUser,
    authToken,
    isLoggedIn,
    isAdmin,
    login,
    register,
    logout,
    getAuthHeaders,
  };
}

export { authToken as sharedAuthToken, authUser as sharedAuthUser };
