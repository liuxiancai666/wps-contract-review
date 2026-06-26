<template>
  <div class="docx-viewer flex-grow min-h-0 overflow-y-auto p-6" ref="container">
    <div class="max-w-4xl mx-auto">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-lg font-semibold text-text-dark">{{ filename || '文档预览' }}</h3>
        <div class="flex items-center gap-2">
          <span v-if="loading" class="text-xs text-text-light">加载中...</span>
          <a v-if="!loading && downloadUrl" :href="downloadUrl" target="_blank"
             class="text-xs text-primary hover:text-primary-dark underline">下载原文件</a>
        </div>
      </div>
      <div v-if="error" class="p-8 text-center text-red-500 bg-red-50 rounded-lg border border-red-200">
        <p>文档加载失败：{{ error }}</p>
        <p class="mt-2 text-xs">
          <a :href="downloadUrl" target="_blank" class="underline">点击下载原文件</a>
        </p>
      </div>
      <div v-else-if="!loading && htmlContent" class="docx-body" v-html="htmlContent"></div>
      <div v-else class="flex items-center justify-center py-20 text-text-light">
        <svg class="animate-spin h-6 w-6 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        正在加载文档...
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import * as mammoth from 'mammoth';

const props = defineProps({
  downloadUrl: { type: String, default: '' },
  filename: { type: String, default: '' },
  contractId: { type: [Number, String], default: null }
});

const container = ref(null);
const htmlContent = ref('');
const loading = ref(true);
const error = ref('');

const loadDocx = async () => {
  if (!props.downloadUrl) {
    loading.value = false;
    error.value = '无文件地址';
    return;
  }
  loading.value = true;
  error.value = '';
  htmlContent.value = '';
  try {
    const response = await fetch(props.downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    htmlContent.value = result.value;
    if (result.messages && result.messages.length > 0) {
      console.warn('[mammoth] Messages:', result.messages);
    }
  } catch (e) {
    console.error('[DocxViewer] Failed to load:', e);
    error.value = e.message || '未知错误';
  } finally {
    loading.value = false;
  }
};

watch(() => props.downloadUrl, (val) => { if (val) loadDocx(); });
onMounted(() => { if (props.downloadUrl) loadDocx(); });
</script>

<style scoped>
.docx-body :deep(h1) { font-size: 1.5rem; font-weight: 700; margin: 1rem 0 0.5rem; }
.docx-body :deep(h2) { font-size: 1.25rem; font-weight: 600; margin: 0.75rem 0 0.5rem; }
.docx-body :deep(h3) { font-size: 1.1rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }
.docx-body :deep(p) { margin: 0.5rem 0; line-height: 1.7; }
.docx-body :deep(ul), .docx-body :deep(ol) { padding-left: 1.5rem; margin: 0.5rem 0; }
.docx-body :deep(li) { margin: 0.25rem 0; line-height: 1.6; }
.docx-body :deep(table) { border-collapse: collapse; width: 100%; margin: 1rem 0; }
.docx-body :deep(td), .docx-body :deep(th) { border: 1px solid #ddd; padding: 6px 10px; font-size: 0.875rem; }
.docx-body :deep(th) { background: #f5f5f5; font-weight: 600; }
.docx-body :deep(img) { max-width: 100%; height: auto; }
.docx-body :deep(blockquote) { border-left: 3px solid #ddd; padding-left: 1rem; margin: 0.5rem 0; color: #666; }
</style>
