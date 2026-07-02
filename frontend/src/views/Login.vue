<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <img src="/asserts/logo_v2.png" alt="牛马在线" class="login-logo" />
        <h1>牛马在线</h1>
        <p class="login-slogan">遇事找牛马，风险全排查</p>
      </div>

      <form @submit.prevent="handleSubmit" class="login-form">
        <div class="form-field">
          <label>用户名</label>
          <input
            v-model="form.username"
            type="text"
            placeholder="输入用户名"
            class="form-input"
            autocomplete="username"
            required
          />
        </div>

        <div class="form-field">
          <label>密码</label>
          <input
            v-model="form.password"
            type="password"
            placeholder="输入密码"
            class="form-input"
            autocomplete="current-password"
            required
          />
        </div>

        <p v-if="error" class="form-error">{{ error }}</p>

        <button type="submit" class="submit-btn" :disabled="submitting">
          {{ submitting ? '处理中...' : (isLogin ? '登 录' : '注 册') }}
        </button>
      </form>

      <div class="login-footer">
        <button class="switch-mode" @click="switchMode">
          {{ isLogin ? '没有账号？注册新账号' : '已有账号？去登录' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuth } from '../composables/useAuth';

export default {
  name: 'LoginView',
  setup() {
    const router = useRouter();
    const route = useRoute();
    const { login, register, isLoggedIn } = useAuth();
    const isLogin = ref(true);
    const submitting = ref(false);
    const error = ref('');
    const form = reactive({ username: '', password: '' });

    // 如果已经登录，跳转到首页
    onMounted(() => {
      if (isLoggedIn.value) {
        const redirect = route.query.redirect || '/';
        router.replace(redirect);
      }
    });

    async function handleSubmit() {
      error.value = '';
      submitting.value = true;
      try {
        if (isLogin.value) {
          await login(form.username, form.password);
        } else {
          await register(form.username, form.password);
        }
        const redirect = route.query.redirect || '/';
        router.replace(redirect);
      } catch (err) {
        error.value = err.message || '操作失败，请重试';
      } finally {
        submitting.value = false;
      }
    }

    function switchMode() {
      isLogin.value = !isLogin.value;
      error.value = '';
    }

    return { form, isLogin, submitting, error, handleSubmit, switchMode };
  },
};
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f5f7fa 0%, #e4e9f0 100%);
  padding: 18px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: #ffffff;
  border-radius: 12px;
  padding: 36px 28px 24px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
}

.login-header {
  text-align: center;
  margin-bottom: 28px;
}

.login-logo {
  width: 96px;
  height: 96px;
  border-radius: 16px;
  margin-bottom: 16px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.12);
}

.login-header h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 800;
  color: #111;
}

.login-slogan {
  margin: 0;
  color: #f39c12;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 2px;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-field label {
  font-size: 12px;
  font-weight: 700;
  color: #333;
}

.form-input {
  height: 40px;
  padding: 0 12px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
  background: #fafafa;
}

.form-input:focus {
  border-color: #111;
  background: #fff;
}

.form-error {
  margin: 0;
  padding: 10px 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #dc2626;
  font-size: 12px;
}

.submit-btn {
  height: 42px;
  border: none;
  border-radius: 8px;
  background: #111;
  color: #fff;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
  transition: background 0.15s;
}

.submit-btn:hover:not(:disabled) {
  background: #333;
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.login-footer {
  text-align: center;
  margin-top: 18px;
}

.switch-mode {
  background: none;
  border: none;
  color: #3b82f6;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  text-decoration: underline;
  padding: 6px;
}

.switch-mode:hover {
  color: #2563eb;
}
</style>
