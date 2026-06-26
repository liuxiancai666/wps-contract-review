<template>
  <div class="pdf-viewer flex-grow min-h-0 overflow-y-auto p-6" ref="container">
    <div class="max-w-4xl mx-auto">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-lg font-semibold text-text-dark">{{ filename || 'PDF预览' }}</h3>
        <div class="flex items-center gap-2">
          <span class="text-xs text-text-light" v-if="pageCount">第 {{ currentPage }} / {{ pageCount }} 页</span>
          <a :href="downloadUrl" target="_blank"
             class="text-xs text-primary hover:text-primary-dark underline">下载原文件</a>
        </div>
      </div>
      <div v-if="error" class="p-8 text-center text-red-500 bg-red-50 rounded-lg border border-red-200">
        <p>PDF加载失败：{{ error }}</p>
        <p class="mt-2 text-xs">
          <a :href="downloadUrl" target="_blank" class="underline">点击下载原文件</a>
        </p>
      </div>
      <div v-else-if="renderedPages.length" class="space-y-4">
        <div v-for="(page, idx) in renderedPages" :key="idx"
             class="bg-white shadow-md rounded-lg overflow-hidden border border-gray-200">
          <img :src="page.dataUrl" class="w-full" :style="{ maxWidth: page.width + 'px' }"
               :alt="`第 ${page.pageNum} 页`" />
          <div class="px-4 py-2 text-xs text-gray-500 border-t border-gray-100 text-center">
            第 {{ page.pageNum }} 页
          </div>
        </div>
        <div v-if="renderedPages.length < pageCount" class="text-center py-4">
          <button @click="renderMorePages"
                 class="px-4 py-2 text-xs font-medium text-primary bg-white border border-primary rounded hover:bg-primary-light transition-colors">
            加载更多（已显示 {{ renderedPages.length }} / {{ pageCount }} 页）
          </button>
        </div>
      </div>
      <div v-else class="flex items-center justify-center py-20 text-text-light">
        <svg class="animate-spin h-6 w-6 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        正在加载PDF...
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';

// Use the bundled worker from node_modules
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const props = defineProps({
  downloadUrl: { type: String, default: '' },
  filename: { type: String, default: '' },
  contractId: { type: [Number, String], default: null }
});

const container = ref(null);
const loading = ref(true);
const error = ref('');
const currentPage = ref(0);
const pageCount = ref(0);
const renderedPages = ref([]);

let pdfDoc = null;

const PAGE_RENDER_BATCH = 3;
const RENDER_SCALE = 1.5;

const renderPage = async (pageNum) => {
  if (!pdfDoc) return null;
  try {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return {
      pageNum,
      dataUrl: canvas.toDataURL('image/jpeg', 0.85),
      width: viewport.width,
      height: viewport.height,
    };
  } catch (e) {
    console.error(`[PdfViewer] Failed to render page ${pageNum}:`, e);
    return null;
  }
};

const renderMorePages = async () => {
  const start = renderedPages.value.length + 1;
  const end = Math.min(start + PAGE_RENDER_BATCH - 1, pageCount.value);
  const promises = [];
  for (let i = start; i <= end; i++) {
    currentPage.value = i;
    promises.push(renderPage(i));
  }
  const results = await Promise.all(promises);
  renderedPages.value.push(...results.filter(Boolean));
};

const loadPdf = async () => {
  if (!props.downloadUrl) {
    loading.value = false;
    error.value = '无文件地址';
    return;
  }
  loading.value = true;
  error.value = '';
  renderedPages.value = [];
  pdfDoc = null;
  try {
    const response = await fetch(props.downloadUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const typedArray = new Uint8Array(arrayBuffer);
    pdfDoc = await pdfjsLib.getDocument({ data: typedArray }).promise;
    pageCount.value = pdfDoc.numPages;
    currentPage.value = 1;
    await renderMorePages();
  } catch (e) {
    console.error('[PdfViewer] Failed to load:', e);
    error.value = e.message || '未知错误';
  } finally {
    loading.value = false;
  }
};

watch(() => props.downloadUrl, (val) => { if (val) loadPdf(); });
onMounted(() => { if (props.downloadUrl) loadPdf(); });
</script>
