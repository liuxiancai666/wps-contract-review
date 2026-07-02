<template>
  <div id="app">
    <header class="app-header" v-if="showHeader">
      <router-link to="/" class="brand" aria-label="合同审查首页">
        <img src="/asserts/logo_v2.png" alt="牛马在线" />
        <span>牛马在线</span>
      </router-link>
      <nav class="app-nav">
        <router-link to="/" class="nav-link" active-class="nav-link-active">工作台</router-link>
        <router-link to="/review" class="nav-link" active-class="nav-link-active">合同审查</router-link>
        <router-link to="/qna" class="nav-link" active-class="nav-link-active">智能问答</router-link>
        <router-link to="/rules" class="nav-link" active-class="nav-link-active">规则</router-link>
        <router-link v-if="isAdmin" to="/settings" class="nav-link" active-class="nav-link-active">知识库</router-link>
        <router-link v-if="isAdmin" to="/admin" class="nav-link" active-class="nav-link-active">管理</router-link>
      </nav>
      <div class="app-user" v-if="isLoggedIn">
        <span class="user-name">{{ authUser?.username }}</span>
        <span v-if="isAdmin" class="admin-badge">管理员</span>
        <button class="logout-btn" @click="handleLogout" title="退出登录">退出</button>
      </div>
    </header>
    <router-view />
  </div>
</template>

<script>
import { computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuth } from './composables/useAuth';

export default {
  name: 'App',
  setup() {
    const router = useRouter();
    const route = useRoute();
    const { authUser, isLoggedIn, isAdmin, logout } = useAuth();

    const showHeader = computed(() => {
      return route.name !== 'Login';
    });

    function handleLogout() {
      logout();
      router.push('/login');
    }

    return { authUser, isLoggedIn, isAdmin, showHeader, handleLogout };
  },
};
</script>

<style>
:root {
  color: #111111;
  background: #ffffff;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  letter-spacing: 0;
}

* {
  box-sizing: border-box;
}

html,
body,
#app {
  min-height: 100%;
  margin: 0;
}

body {
  background: #ffffff;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a {
  color: inherit;
}

.app-header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 0 18px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(18px);
  box-shadow: inset 0 -1px 0 #e5e5e5;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #111111;
  text-decoration: none;
  font-size: 15px;
  font-weight: 900;
  white-space: nowrap;
}

.brand img {
  width: 26px;
  height: 26px;
  border-radius: 8px;
}

.app-nav {
  display: flex;
  align-items: center;
  gap: 5px;
  overflow-x: auto;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 8px;
  color: #666666;
  text-decoration: none;
  font-size: 13px;
  font-weight: 800;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.nav-link:hover {
  color: #111111;
  background: #f5f5f5;
}

.nav-link-active {
  color: #ffffff;
  background: #111111;
}

.el-button,
.el-input__wrapper,
.el-textarea__inner,
.el-select__wrapper {
  border-radius: 8px !important;
}

.el-input__wrapper,
.el-select__wrapper {
  min-height: 34px !important;
}

.el-textarea__inner {
  font-size: 13px !important;
  line-height: 1.45 !important;
}

@media (max-width: 680px) {
  .app-header {
    height: auto;
    min-height: 56px;
    align-items: flex-start;
    flex-direction: column;
    padding: 10px 14px;
  }

  .app-nav {
    width: 100%;
  }
}

.app-user {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.user-name {
  font-size: 12px;
  font-weight: 700;
  color: #333;
  white-space: nowrap;
}

.admin-badge {
  display: inline-flex;
  border-radius: 999px;
  padding: 2px 6px;
  background: #fef3c7;
  color: #92400e;
  font-size: 10px;
  font-weight: 800;
}

.logout-btn {
  background: none;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  color: #666;
  transition: all 0.12s;
}

.logout-btn:hover {
  background: #f5f5f5;
  color: #ef4444;
  border-color: #fecaca;
}
</style>
