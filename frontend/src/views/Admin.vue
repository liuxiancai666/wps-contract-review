<template>
  <div class="admin-page">
    <div class="admin-header">
      <div>
        <p class="eyebrow">系统管理</p>
        <h2>用户管理</h2>
      </div>
      <button class="secondary-button" @click="fetchUsers">刷新</button>
    </div>

    <div v-if="loading" class="empty-block">加载中...</div>
    <div v-else-if="error" class="empty-block danger">{{ error }}</div>

    <div v-else class="table-wrap">
      <table class="user-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>用户名</th>
            <th>角色</th>
            <th>设备指纹</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td>{{ user.id }}</td>
            <td>
              <input
                v-if="editingId === user.id"
                v-model="editForm.username"
                class="edit-input"
                placeholder="用户名"
              />
              <span v-else class="username-label">{{ user.username || '(匿名)' }}</span>
            </td>
            <td>
              <select
                v-if="editingId === user.id"
                v-model="editForm.role"
                class="edit-select"
              >
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
              <span v-else :class="['role-pill', user.role === 'admin' ? 'admin' : 'user']">
                {{ user.role === 'admin' ? '管理员' : '普通用户' }}
              </span>
            </td>
            <td class="fp-cell" :title="user.fingerprint_id">
              {{ user.fingerprint_id ? user.fingerprint_id.slice(0, 16) + '...' : '—' }}
            </td>
            <td>{{ formatDate(user.created_at) }}</td>
            <td>
              <div class="row-actions">
                <template v-if="editingId === user.id">
                  <button class="text-button primary" @click="saveEdit(user)">保存</button>
                  <button class="text-button" @click="cancelEdit">取消</button>
                </template>
                <template v-else>
                  <button class="text-button" @click="startEdit(user)">编辑</button>
                  <el-popconfirm
                    :title="`确认删除用户「${user.username || '匿名'}」？`"
                    @confirm="deleteUser(user)"
                  >
                    <template #reference>
                      <button class="text-button danger" :disabled="user.id === currentUserId">删除</button>
                    </template>
                  </el-popconfirm>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script>
import { ref, computed, onMounted } from 'vue';
import { ElPopconfirm, ElMessage } from 'element-plus';
import { useAuth } from '../composables/useAuth';

const API_BASE = import.meta.env.VITE_APP_BACKEND_API_URL || '';

export default {
  name: 'AdminView',
  components: { ElPopconfirm },
  setup() {
    const { authUser, getAuthHeaders } = useAuth();
    const users = ref([]);
    const loading = ref(true);
    const error = ref('');
    const editingId = ref(null);
    const editForm = ref({ username: '', role: '' });
    const currentUserId = computed(() => authUser.value?.id);

    const fetchUsers = async () => {
      loading.value = true;
      error.value = '';
      try {
        const res = await fetch(`${API_BASE}/api/auth/users`, {
          headers: { ...getAuthHeaders() },
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '获取用户列表失败');
        }
        users.value = await res.json();
      } catch (err) {
        error.value = err.message;
      } finally {
        loading.value = false;
      }
    };

    const formatDate = (d) => {
      if (!d) return '—';
      return new Date(d).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    };

    const startEdit = (user) => {
      editingId.value = user.id;
      editForm.value = { username: user.username || '', role: user.role };
    };

    const cancelEdit = () => {
      editingId.value = null;
      editForm.value = { username: '', role: '' };
    };

    const saveEdit = async (user) => {
      try {
        const body = {};
        if (editForm.value.username !== (user.username || '')) {
          body.username = editForm.value.username;
        }
        if (editForm.value.role !== user.role) {
          body.role = editForm.value.role;
        }
        if (Object.keys(body).length === 0) {
          cancelEdit();
          return;
        }

        const res = await fetch(`${API_BASE}/api/auth/users/${user.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '更新失败');
        }
        ElMessage.success('更新成功');
        cancelEdit();
        await fetchUsers();
      } catch (err) {
        ElMessage.error(err.message);
      }
    };

    const deleteUser = async (user) => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/users/${user.id}`, {
          method: 'DELETE',
          headers: { ...getAuthHeaders() },
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || '删除失败');
        }
        ElMessage.success('删除成功');
        await fetchUsers();
      } catch (err) {
        ElMessage.error(err.message);
      }
    };

    onMounted(fetchUsers);

    return {
      users, loading, error,
      editingId, editForm, currentUserId,
      fetchUsers, formatDate,
      startEdit, cancelEdit, saveEdit, deleteUser,
    };
  },
};
</script>

<style scoped>
.admin-page {
  max-width: 960px;
  margin: 18px auto;
  padding: 0 18px;
}

.admin-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 16px;
}

.admin-header h2 {
  margin: 0;
  font-size: 20px;
}

.eyebrow {
  margin: 0 0 4px;
  color: #666;
  font-size: 11px;
  font-weight: 800;
}

.secondary-button {
  min-height: 34px;
  padding: 0 13px;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  background: #fff;
  font-weight: 800;
  cursor: pointer;
}

.empty-block {
  padding: 40px;
  text-align: center;
  color: #666;
  background: #fafafa;
  border-radius: 8px;
}

.empty-block.danger {
  color: #ef4444;
}

.table-wrap {
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px #e5e5e5;
  overflow: hidden;
}

.user-table {
  width: 100%;
  border-collapse: collapse;
}

.user-table th,
.user-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  text-align: left;
  font-size: 12px;
  vertical-align: middle;
}

.user-table th {
  background: #fafafa;
  color: #666;
  font-weight: 800;
}

.user-table tbody tr:hover {
  background: #f8f8f8;
}

.username-label {
  font-weight: 700;
}

.fp-cell {
  color: #999;
  font-family: monospace;
  font-size: 11px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-pill {
  display: inline-flex;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 800;
}

.role-pill.admin {
  background: #fef3c7;
  color: #92400e;
}

.role-pill.user {
  background: #dbeafe;
  color: #1d4ed8;
}

.edit-input,
.edit-select {
  height: 32px;
  padding: 0 8px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  font-size: 12px;
  outline: none;
}

.edit-input:focus,
.edit-select:focus {
  border-color: #3b82f6;
}

.edit-select {
  cursor: pointer;
}

.row-actions {
  display: flex;
  gap: 6px;
}

.text-button {
  background: none;
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  color: #333;
}

.text-button:hover {
  background: #f5f5f5;
}

.text-button.danger {
  color: #ef4444;
}

.text-button.danger:hover {
  background: #fef2f2;
}

.text-button.primary {
  color: #2563eb;
  border-color: #2563eb;
}

.text-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
