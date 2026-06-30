<template>
  <main class="rules-page">
    <section class="rules-head">
      <p class="eyebrow">审查规则</p>
      <h1>自定义审查规则库</h1>
      <p>创建和管理您自己的合同审查规则。自定义规则会与系统预设模板一同显示在合同审查页面的下拉菜单中。</p>
    </section>

    <!-- 空状态提示 -->
    <div v-if="!loading && items.length === 0" class="empty-state">
      <svg class="empty-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      <h3>暂无自定义规则</h3>
      <p>创建您的第一条审查规则，点击下方按钮开始。</p>
      <button class="primary-button" @click="openCreateDialog">创建规则</button>
    </div>

    <!-- 规则列表 -->
    <section v-else class="panel rules-list-panel">
      <div class="panel-title">
        <div>
          <h2>规则列表</h2>
          <p>共 {{ items.length }} 条规则</p>
        </div>
        <button class="primary-button" @click="openCreateDialog">+ 新建规则</button>
      </div>

      <div v-if="loading" class="loading-state">加载中...</div>

      <div v-else class="rules-grid">
        <article v-for="rule in items" :key="rule.id" class="rule-card" :class="{ 'rule-disabled': !rule.is_enabled }">
          <div class="rule-card-header">
            <h3>{{ rule.name }}</h3>
            <el-tag v-if="!rule.is_enabled" size="small" type="info">已禁用</el-tag>
          </div>

          <div v-if="rule.contract_type_keywords" class="rule-keywords">
            <el-tag v-for="kw in parseKeywords(rule.contract_type_keywords)" :key="kw" size="small" type="warning" effect="plain">{{ kw }}</el-tag>
          </div>

          <div class="rule-stats">
            <span>审查点：{{ rule.review_points?.length || 0 }} 项</span>
            <span>审查目的：{{ rule.core_purposes?.length || 0 }} 项</span>
            <span>审查规则：{{ rule.prompt_rules?.length || 0 }} 条</span>
          </div>

          <div class="rule-card-actions">
            <button class="text-button" @click="editRule(rule)">编辑</button>
            <button class="text-button" @click="toggleRule(rule)">{{ rule.is_enabled ? '禁用' : '启用' }}</button>
            <button class="text-danger" @click="confirmDelete(rule)">删除</button>
          </div>
        </article>
      </div>
    </section>

    <!-- 创建/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="editingRule ? '编辑规则' : '新建规则'" width="min(720px, calc(100vw - 32px))" class="rule-dialog">
      <div class="dialog-body">
        <div class="form-group">
          <label>规则名称 <span class="required">*</span></label>
          <el-input v-model="form.name" placeholder="例如：国际工程分包合同审查" />
        </div>

        <div class="form-group">
          <label>匹配关键词</label>
          <el-input v-model="form.contract_type_keywords" placeholder="用逗号分隔，例如：工程, 分包, 国际工程" />
          <p class="form-help">合同预分析时自动匹配此规则。多个关键词用逗号分隔。</p>
        </div>

        <div class="form-group">
          <label>审查点列表（每行一个）</label>
          <el-input
            v-model="form.review_points_text"
            type="textarea"
            :rows="5"
            placeholder="工程质量标准与验收&#10;进度款支付与结算程序&#10;工程变更与签证管理"
          />
        </div>

        <div class="form-group">
          <label>审查核心目的（每行一个）</label>
          <el-input
            v-model="form.core_purposes_text"
            type="textarea"
            :rows="3"
            placeholder="明确工程范围、工期与质量标准&#10;控制进度款支付与结算风险"
          />
        </div>

        <div class="form-group">
          <label>审查指引规则（每行一个）</label>
          <el-input
            v-model="form.prompt_rules_text"
            type="textarea"
            :rows="4"
            placeholder="重点核查工期、价款、质量标准和验收程序&#10;工程变更必须以书面签证为准"
          />
        </div>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <button class="secondary-button" @click="dialogVisible = false">取消</button>
          <button class="primary-button" :disabled="saving || !form.name.trim()" @click="saveRule">
            {{ saving ? '保存中...' : (editingRule ? '保存修改' : '创建规则') }}
          </button>
        </div>
      </template>
    </el-dialog>
  </main>
</template>

<script>
import { computed, onMounted, ref } from 'vue';
import { ElDialog, ElInput, ElMessage, ElMessageBox, ElTag } from 'element-plus';
import api, { apiClient } from '../api';

export default {
  name: 'RulesView',
  components: { ElDialog, ElInput, ElTag },
  setup() {
    const items = ref([]);
    const loading = ref(false);
    const dialogVisible = ref(false);
    const editingRule = ref(null);
    const saving = ref(false);
    const form = ref(createEmptyForm());

    function createEmptyForm() {
      return {
        name: '',
        contract_type_keywords: '',
        review_points_text: '',
        core_purposes_text: '',
        prompt_rules_text: '',
      };
    }

    function parseKeywords(str) {
      if (!str) return [];
      return String(str).split(/[,，、\s]+/).filter(Boolean);
    }

    function resetForm() {
      form.value = createEmptyForm();
    }

    function formToPayload() {
      return {
        name: form.value.name.trim(),
        contract_type_keywords: form.value.contract_type_keywords.trim(),
        review_points: form.value.review_points_text.split('\n').map((s) => s.trim()).filter(Boolean),
        core_purposes: form.value.core_purposes_text.split('\n').map((s) => s.trim()).filter(Boolean),
        prompt_rules: form.value.prompt_rules_text.split('\n').map((s) => s.trim()).filter(Boolean),
      };
    }

    function payloadToForm(rule) {
      return {
        name: rule.name || '',
        contract_type_keywords: rule.contract_type_keywords || '',
        review_points_text: (rule.review_points || []).join('\n'),
        core_purposes_text: (rule.core_purposes || []).join('\n'),
        prompt_rules_text: (rule.prompt_rules || []).join('\n'),
      };
    }

    const loadRules = async () => {
      loading.value = true;
      try {
        const response = await apiClient.get('/rules');
        items.value = response.data.items || [];
      } catch {
        ElMessage.error('加载规则列表失败。');
      } finally {
        loading.value = false;
      }
    };

    const openCreateDialog = () => {
      editingRule.value = null;
      resetForm();
      dialogVisible.value = true;
    };

    const editRule = (rule) => {
      editingRule.value = rule;
      form.value = payloadToForm(rule);
      dialogVisible.value = true;
    };

    const saveRule = async () => {
      if (!form.value.name.trim()) return;
      saving.value = true;
      try {
        const payload = formToPayload();
        if (editingRule.value) {
          await apiClient.put(`/rules/${editingRule.value.id}`, payload);
          ElMessage.success('规则已更新。');
        } else {
          await apiClient.post('/rules', payload);
          ElMessage.success('规则已创建。');
        }
        dialogVisible.value = false;
        await loadRules();
      } catch (error) {
        ElMessage.error(error.response?.data?.error || '保存失败。');
      } finally {
        saving.value = false;
      }
    };

    const toggleRule = async (rule) => {
      try {
        await apiClient.put(`/rules/${rule.id}`, { is_enabled: !rule.is_enabled });
        await loadRules();
        ElMessage.success(rule.is_enabled ? '规则已禁用。' : '规则已启用。');
      } catch (error) {
        ElMessage.error(error.response?.data?.error || '操作失败。');
      }
    };

    const confirmDelete = async (rule) => {
      try {
        await ElMessageBox.confirm(`确认删除规则「${rule.name}」？删除后无法恢复。`, '确认删除', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' });
        await apiClient.delete(`/rules/${rule.id}`);
        ElMessage.success('规则已删除。');
        await loadRules();
      } catch (error) {
        if (error === 'cancel' || error === 'close') return;
        ElMessage.error(error.response?.data?.error || '删除失败。');
      }
    };

    onMounted(loadRules);

    return {
      items, loading, dialogVisible, editingRule, saving, form,
      parseKeywords, openCreateDialog, editRule, saveRule, toggleRule, confirmDelete,
    };
  },
};
</script>

<style scoped>
.rules-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 32px 16px;
}
.rules-head {
  margin-bottom: 28px;
}
.rules-head .eyebrow {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #8c8c8c;
  margin-bottom: 4px;
}
.rules-head h1 {
  font-size: 24px;
  font-weight: 900;
  margin: 0 0 8px;
}
.rules-head p {
  font-size: 14px;
  color: #666;
  max-width: 600px;
  line-height: 1.5;
}
.empty-state {
  text-align: center;
  padding: 60px 20px;
}
.empty-icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 16px;
  color: #d9d9d9;
}
.empty-state h3 {
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 8px;
}
.empty-state p {
  font-size: 14px;
  color: #666;
  margin-bottom: 20px;
}
.panel {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  border: 1px solid #f0f0f0;
}
.panel-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}
.panel-title h2 {
  font-size: 18px;
  font-weight: 800;
  margin: 0;
}
.panel-title p {
  font-size: 13px;
  color: #8c8c8c;
  margin: 2px 0 0;
}
.loading-state {
  text-align: center;
  padding: 40px;
  color: #8c8c8c;
}
.rules-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.rule-card {
  background: #fafafa;
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  padding: 16px;
  transition: box-shadow 0.15s;
}
.rule-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
}
.rule-card.rule-disabled {
  opacity: 0.65;
}
.rule-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.rule-card-header h3 {
  font-size: 15px;
  font-weight: 700;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rule-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
}
.rule-stats {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #8c8c8c;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.rule-card-actions {
  display: flex;
  gap: 12px;
  border-top: 1px solid #f0f0f0;
  padding-top: 10px;
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-group label {
  font-size: 13px;
  font-weight: 700;
}
.form-group .required {
  color: #e63946;
}
.form-help {
  font-size: 12px;
  color: #8c8c8c;
  margin: 2px 0 0;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.primary-button {
  padding: 8px 18px;
  background: #111;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s;
}
.primary-button:hover { opacity: 0.85; }
.primary-button:disabled { opacity: 0.4; cursor: not-allowed; }
.secondary-button {
  padding: 8px 18px;
  background: #fff;
  color: #111;
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.secondary-button:hover { background: #f5f5f5; }
.text-button {
  background: none;
  border: none;
  color: #1677ff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.text-button:hover { opacity: 0.8; }
.text-danger {
  background: none;
  border: none;
  color: #e63946;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.text-danger:hover { opacity: 0.8; }
</style>
