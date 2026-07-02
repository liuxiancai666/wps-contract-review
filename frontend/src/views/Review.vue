<template>
  <div class="review-page w-full h-full flex flex-col">
    <!-- Custom Steps Header -->
    <div class="flex-shrink-0 mb-2 p-2 bg-white rounded-lg shadow-sm">
      <div class="flex items-center">
        <div class="flex items-center text-xs" :class="activeStep >= 0 ? 'text-primary' : 'text-gray-500'">
          <div class="flex items-center justify-center w-5 h-5 rounded-full border-2" :class="activeStep >= 0 ? 'border-primary' : 'border-gray-400'">
            <span v-if="activeStep > 0">✓</span><span v-else>1</span>
          </div>
          <span class="ml-1 font-semibold">上传合同</span>
        </div>
        <div class="flex-auto border-t-2 mx-2" :class="activeStep >= 1 ? 'border-primary' : 'border-gray-300'"></div>
        <div class="flex items-center text-xs" :class="activeStep >= 1 ? 'text-primary' : 'text-gray-500'">
          <div class="flex items-center justify-center w-5 h-5 rounded-full border-2" :class="activeStep >= 1 ? 'border-primary' : 'border-gray-400'">
             <span v-if="activeStep > 1">✓</span><span v-else>2</span>
          </div>
          <span class="ml-1 font-semibold">确认信息并分析</span>
        </div>
        <div class="flex-auto border-t-2 mx-2" :class="activeStep >= 2 ? 'border-primary' : 'border-gray-300'"></div>
        <div class="flex items-center text-xs" :class="activeStep >= 2 ? 'text-primary' : 'text-gray-500'">
          <div class="flex items-center justify-center w-5 h-5 rounded-full border-2" :class="activeStep >= 2 ? 'border-primary' : 'border-gray-400'">
            <span>3</span>
          </div>
          <span class="ml-1 font-semibold">查看并编辑结果</span>
        </div>
      </div>
    </div>

    <!-- Step 0: Upload -->
    <div v-if="activeStep === 0" class="flex-grow overflow-y-auto flex flex-col items-center py-8 px-4 text-center">
      <h1 class="text-3xl font-bold tracking-tight text-text-dark sm:text-4xl">智能合同审查</h1>
      <p class="mt-3 text-base leading-7 text-text-light">上传您的合同文档，AI 将为您深度分析、识别风险、守护权益。</p>

      <div class="mt-10 w-full max-w-2xl">
        <el-upload
          class="upload-dragger"
          drag
          action=""
          :http-request="({ file }) => uploadAndGo(file)"
          :before-upload="handleBeforeUpload"
          :show-file-list="false"
        >
          <div class="flex flex-col items-center justify-center p-10">
            <svg class="mx-auto h-12 w-12 text-text-light" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <div class="mt-4 flex text-sm leading-6 text-gray-600">
              <span class="font-semibold text-primary">点击上传</span>
              <p class="pl-1">或将文件拖到此处</p>
            </div>
            <p class="text-xs leading-5 text-gray-500">支持 .docx、.doc 和 .pdf 格式（PDF 需为可复制的文字版，不支持扫描件）</p>
          </div>
        </el-upload>
      </div>

      <div class="linked-analysis-panel mt-8 w-full max-w-2xl text-left">
        <div>
          <p class="text-sm font-semibold text-primary">多合同关联分析</p>
          <h2 class="mt-1 text-xl font-semibold text-text-dark">同时审查主合同、附件和补充协议</h2>
          <p class="mt-2 text-sm text-text-light">选择至少 2 份 DOCX 或 PDF 文件，系统会识别条款冲突、重复约定、遗漏和前后矛盾。</p>
        </div>
        <div class="linked-analysis-panel__picker">
          <input
            ref="linkedFileInput"
            type="file"
            multiple
            accept=".docx,.doc,.pdf"
            @change="handleLinkedFilesChange"
            class="linked-analysis-panel__native-input"
          />
          <button type="button" class="linked-analysis-panel__file-button" @click="openLinkedFilePicker">
            选择关联合同文件
          </button>
          <span class="linked-analysis-panel__count">已选择 {{ linkedGroupFiles.length }} 份</span>
          <button
            @click="startLinkedContractAnalysis"
            :disabled="linkedAnalysisLoading || linkedGroupFiles.length < 2"
            class="linked-analysis-panel__button"
          >
            {{ linkedAnalysisLoading ? '正在分析关联合同...' : '开始多合同关联分析' }}
          </button>
        </div>
        <div v-if="linkedGroupFiles.length" class="linked-analysis-panel__files">
          <span v-for="file in linkedGroupFiles" :key="file.name + file.size">{{ file.name }}</span>
        </div>
        <div v-if="linkedAnalysisProgress.length" class="linked-analysis-panel__progress">
          <div v-for="item in linkedAnalysisProgress" :key="item.key" class="linked-analysis-panel__progress-row">
            <span :class="['linked-analysis-panel__progress-dot', `linked-analysis-panel__progress-dot--${item.status}`]"></span>
            <div>
              <strong>{{ item.label }}</strong>
              <p>{{ item.message }}</p>
            </div>
          </div>
        </div>
        <div v-if="linkedAnalysisResult" class="linked-analysis-result">
          <h3>关联分析结果</h3>
          <p v-if="linkedAnalysisResult.summary" class="linked-analysis-result__summary">{{ linkedAnalysisResult.summary }}</p>
          <div v-if="linkedAnalysisResult.conflicts?.length" class="linked-analysis-result__section">
            <h4>条款冲突与矛盾</h4>
            <div v-for="(item, index) in linkedAnalysisResult.conflicts" :key="'conflict-' + index" class="linked-analysis-result__item">
              <strong>{{ item.title || `冲突点 ${index + 1}` }}</strong>
              <p>{{ item.description }}</p>
              <p v-if="item.contract_refs?.length">涉及文件：{{ item.contract_refs.join('、') }}</p>
              <p v-if="item.suggestion">处理建议：{{ item.suggestion }}</p>
            </div>
          </div>
          <div v-if="linkedAnalysisResult.shared_risks?.length" class="linked-analysis-result__section">
            <h4>跨合同共同风险</h4>
            <ul>
              <li v-for="(risk, index) in linkedAnalysisResult.shared_risks" :key="'shared-risk-' + index">{{ risk }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 1: Pre-analysis & Settings -->
    <div v-if="activeStep === 1" class="confirm-step w-full max-w-5xl mx-auto py-8">
      <!-- 预分析加载状态 -->
      <div v-if="preAnalyzing" class="text-center py-16">
        <div class="inline-flex items-center justify-center w-16 h-16 mb-4">
          <svg class="animate-spin h-10 w-10 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <h3 class="text-xl font-semibold text-text-dark mb-2">正在分析合同内容…</h3>
        <p class="text-sm text-text-light">AI 正在识别合同类型、提取条款结构，请稍候</p>
      </div>

      <!-- 预分析完成 / 用户可确认 -->
      <div v-else>
        <div class="text-center mb-10">
            <p class="text-lg text-text-main">文件 <span class="font-semibold text-primary">{{ contract.original_filename }}</span> 已上传成功。</p>
            <div class="mt-2 flex items-center justify-center gap-2">
                <p class="text-md text-text-light">AI 初步识别该合同为：</p>
                <el-input
                    v-model="preAnalysisData.contract_type"
                    class="contract-type-edit"
                    size="small"
                    style="width: 240px;"
                    placeholder="可修改合同类型"
                />
            </div>
            <button @click="showContractPreview = !showContractPreview" class="mt-3 text-sm font-medium text-primary hover:text-primary-dark inline-flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 transition-transform" :class="{ 'rotate-180': showContractPreview }" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
                {{ showContractPreview ? '收起合同预览' : '查看合同预览' }}
                <span v-if="preAnalysisData.text_stats" class="text-xs text-text-light font-normal">（{{ preAnalysisData.text_stats.charCount }} 字）</span>
            </button>
            <div v-if="showContractPreview" class="mt-3 mx-auto max-w-3xl text-left bg-white border border-border-color rounded-lg p-4 max-h-60 overflow-y-auto">
                <p class="text-sm text-text-main leading-relaxed whitespace-pre-line">{{ contractPreviewText }}</p>
                <p v-if="preAnalysisData.text_stats && preAnalysisData.text_stats.charCount > 200" class="mt-2 pt-2 border-t border-border-color text-xs text-text-light text-center">仅展示前 200 字，完整内容将在审查后显示</p>
            </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-8">
            <!-- Left Panel: Perspective -->
            <div class="bg-white rounded-lg shadow-md p-6">
                <h3 class="text-lg font-semibold text-text-dark">1. 选择您的审查立场</h3>
                <p class="text-sm text-text-light mt-1">AI将基于您的立场进行侧重分析。</p>
                <div class="mt-4">
                    <el-select v-model="perspective" placeholder="请选择您的立场" class="w-full"  filterable allow-create>
                        <el-option
                        v-for="party in allPotentialParties"
                        :key="party"
                        :label="party"
                        :value="party">
                        </el-option>
                    </el-select>
                </div>
            </div>

            <!-- Right Panel: Actions -->
            <div class="bg-white rounded-lg shadow-md p-6 flex flex-col justify-between">
                <div>
                    <h3 class="text-lg font-semibold text-text-dark">2. 确认审查范围</h3>
                    <p class="text-sm text-text-light mt-1">默认已全选AI建议的审查点。</p>
                    <div class="mt-4">
                        <label class="block text-sm font-medium text-text-main mb-1">审查模板</label>
                        <el-select v-model="selectedTemplateId" placeholder="选择审查模板" class="w-full">
                            <el-option
                                v-for="template in reviewTemplates"
                                :key="template.id"
                                :label="template.name"
                                :value="template.id"
                            />
                        </el-select>
                    </div>
                </div>
                <div class="mt-6 flex justify-end space-x-3">
                     <button @click="goBackToUpload" class="px-4 py-2 text-sm font-medium text-text-main bg-white border border-border-color rounded-md hover:bg-bg-subtle focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary">
                        重新上传
                    </button>
                    <button @click="startAnalysis" :disabled="!perspective" class="px-6 py-2 text-sm font-medium text-white bg-primary border border-transparent rounded-md shadow-sm hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed">
                        开始分析
                    </button>
                </div>
            </div>
        </div>

         <!-- Bottom Panel: Review Points & Purposes -->
        <div class="review-options-panel bg-white rounded-lg shadow-md p-6 mt-8">
            <h3 class="text-lg font-semibold text-text-dark mb-4">审查点及核心目的</h3>
            <div class="mb-6">
                <h4 class="text-md font-medium text-text-dark mb-2">审查点选择 (可多选)</h4>
                <el-checkbox-group v-model="selectedReviewPoints" class="review-points-group flex flex-wrap gap-3">
                    <el-checkbox
                    v-for="point in allSuggestedReviewPoints"
                    :key="point"
                    :label="point"
                    :value="point"
                    border
                    ></el-checkbox>
                </el-checkbox-group>
            </div>
            <div>
                 <h4 class="text-md font-medium text-text-dark mb-2">审查核心目的 (可自定义)</h4>
                 <div v-for="(purpose, index) in customPurposes" :key="index" class="purpose-row flex items-center mb-2">
                    <el-autocomplete
                        v-model="purpose.value"
                        :fetch-suggestions="querySearchCorePurposes"
                        placeholder="搜索或输入新目的"
                        class="w-full"
                        trigger-on-focus
                    ></el-autocomplete>
                    <button @click="removePurpose(index)" class="ml-2 text-gray-400 hover:text-danger">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </button>
                 </div>
                 <button @click="addPurpose" class="mt-2 text-sm font-medium text-primary hover:text-primary-dark flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    添加目的
                 </button>
            </div>
        </div>
      </div>
    </div>

    <!-- Step 2: Review & Edit -->
    <div v-if="activeStep === 2" class="flex-grow min-h-0 flex space-x-4">
        <!-- Left Side: WPS Document Editor (full-provider pattern) -->
        <div class="w-2/3 bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
            <!-- Editor Toolbar (full-provider style header) -->
            <div class="px-3 py-2 border-b border-border-color bg-bg-subtle flex items-center justify-between gap-3 flex-wrap">
                <div class="flex items-center gap-2 text-sm text-text-main">
                    <!-- Editor status indicator -->
                    <span v-if="isEditorReady" class="inline-flex items-center gap-1 text-green-700 font-medium">
                        <span class="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                        <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        可在线编辑
                    </span>
                    <span v-else class="inline-flex items-center gap-1 text-text-light">
                        <svg class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                        加载中...
                    </span>
                    <!-- Pending changes indicator -->
                    <span v-if="hasPendingEditorChanges && isEditorReady" class="inline-flex items-center gap-1 text-amber-600 text-xs">
                        <span class="inline-block w-1.5 h-1.5 bg-amber-500 rounded-full"></span>
                        待保存
                    </span>
                </div>

                <!-- Editor Actions (full-provider feature buttons) -->
                <div class="flex items-center gap-2 flex-wrap">
                    <!-- Read selected text for review -->
                    <button @click="prepareFocusedReviewFromSelection" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark flex items-center gap-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
                        读取选中文本审查
                    </button>

                    <!-- Version History -->
                    <div class="relative" ref="versionHistoryDropdown">
                        <button @click="toggleVersionHistory" class="px-3 py-1.5 text-xs font-medium text-text-main bg-white border border-border-color rounded hover:bg-bg-subtle flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                            版本历史
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        <!-- Version History Dropdown -->
                        <div v-if="showVersionHistory" class="absolute top-full right-0 mt-1 bg-white shadow-lg rounded border z-50 min-w-64 max-h-80 overflow-y-auto">
                            <div class="p-3 border-b border-border-color flex justify-between items-center">
                                <p class="text-sm font-semibold text-text-dark">版本历史</p>
                                <button @click="loadVersionHistory" class="text-xs text-primary hover:underline">刷新</button>
                            </div>
                            <div v-if="versionHistoryLoading" class="p-4 text-center text-xs text-text-light">加载中...</div>
                            <div v-else-if="versionHistory.length === 0" class="p-4 text-center text-xs text-text-light">暂无版本记录</div>
                            <div v-else>
                                <div v-for="version in versionHistory" :key="version.id" class="px-3 py-2 hover:bg-bg-subtle cursor-pointer border-b border-border-color text-xs last:border-b-0 last:mb-0">
                                    <div class="flex justify-between items-start">
                                        <div>
                                            <p class="font-medium text-text-main">{{ version.name }}</p>
                                            <p class="text-text-light mt-0.5">{{ formatVersionTime(version.modify_time) }}</p>
                                            <p class="text-text-light">版本 v{{ version.version }}</p>
                                        </div>
                                        <div class="flex gap-1">
                                            <button @click="previewVersion(version)" class="px-2 py-0.5 text-xs text-primary border border-primary rounded hover:bg-primary hover:text-white">预览</button>
                                            <button v-if="version.version !== versionHistory[0]?.version" @click="restoreVersion(version)" class="px-2 py-0.5 text-xs text-green-600 border border-green-400 rounded hover:bg-green-500 hover:text-white">恢复</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Watermark Toggle -->
                    <div class="relative" ref="watermarkDropdown">
                        <button @click="toggleWatermarkMenu" class="px-3 py-1.5 text-xs font-medium text-text-main bg-white border border-border-color rounded hover:bg-bg-subtle flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                            水印
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        <div v-if="showWatermarkMenu" class="absolute top-full right-0 mt-1 bg-white shadow-lg rounded border z-50 min-w-48">
                            <div class="p-3">
                                <p class="text-xs font-semibold text-text-dark mb-2">水印配置</p>
                                <label class="flex items-center gap-2 text-xs text-text-main mb-2">
                                    <input type="checkbox" v-model="watermarkEnabled" @change="toggleWatermark" class="w-3 h-3">
                                    启用文档水印
                                </label>
                                <div v-if="watermarkEnabled">
                                    <el-input v-model="watermarkText" size="small" placeholder="水印文字" class="mb-1"></el-input>
                                    <button @click="applyWatermark" class="w-full px-2 py-1 text-xs text-white bg-primary rounded hover:bg-primary-dark mt-1">应用水印</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Refresh document (reload from server) -->
                    <button @click="reloadDocument" class="px-3 py-1.5 text-xs font-medium text-text-main bg-white border border-border-color rounded hover:bg-bg-subtle flex items-center gap-1" title="刷新文档">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        刷新
                    </button>
                </div>
            </div>
            <WpsEditor
                ref="wpsEditorRef"
                v-if="contract.id"
                :contract-id="contract.id"
                :mode="editMode"
                @onDocumentReady="onDocumentReady"
                @onDocumentStateChange="onDocumentStateChange"
                @onButtonAction="handleWpsButtonAction"
                @onError="onEditorError"
            />
            <div v-if="selectedSuggestionPreview" class="border-t border-border-color bg-white p-3 max-h-44 overflow-y-auto">
                <div class="flex items-center justify-between">
                    <p class="text-sm font-semibold text-text-dark">最近采纳预览</p>
                    <span class="text-xs text-green-700">{{ selectedSuggestionPreview.status }}</span>
                </div>
                <div class="mt-2 grid grid-cols-2 gap-3 text-xs">
                    <div>
                        <p class="text-gray-500 font-medium">采纳前原文</p>
                        <p class="mt-1 p-2 bg-red-50 text-red-800 border border-red-100 rounded whitespace-pre-line">{{ selectedSuggestionPreview.before }}</p>
                    </div>
                    <div>
                        <p class="text-gray-500 font-medium">采纳后文本</p>
                        <p class="mt-1 p-2 bg-green-50 text-green-800 border border-green-100 rounded whitespace-pre-line">{{ selectedSuggestionPreview.after }}</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- Right Side: AI Review Panel -->
        <div class="w-1/3 bg-white rounded-lg shadow-md flex flex-col h-full">
            <!-- Panel Header -->
            <div class="p-3 border-b border-border-color flex justify-between items-center flex-shrink-0">
                <div class="flex items-center">
                    <h3 class="text-lg font-semibold text-text-dark">AI 审查报告</h3>
                    <div class="ml-4 flex items-center">
                        <span class="text-xs text-text-light mr-1">大白话模式</span>
                        <el-switch v-model="showPlainLanguage" size="small"></el-switch>
                    </div>
                </div>
                <div>
                    <button @click="exportAnnotatedDocx" class="mr-3 text-sm font-medium text-green-600 hover:text-green-700">导出带批注Word</button>
                    <button @click="exportReport('pdf')" class="mr-3 text-sm font-medium text-primary hover:text-primary-dark">导出PDF</button>
                    <button @click="exportReport('word')" class="mr-3 text-sm font-medium text-primary hover:text-primary-dark">导出Word</button>
                    <button v-if="!isPdfContract" @click="exportAnnotatedDocx" class="mr-3 text-sm font-medium text-primary hover:text-primary-dark">导出带批注文档</button>
                    <button @click="downloadPdfAnnotations" class="mr-3 text-sm font-medium text-primary hover:text-primary-dark">PDF批注</button>
                    <button @click="toggleRevisionMenu" class="mr-3 text-sm font-medium text-primary hover:text-primary-dark relative">
                        修订操作 ▾
                        <div v-if="showRevisionMenu" class="absolute top-full left-0 mt-1 bg-white shadow-lg rounded border z-50 min-w-36">
                            <div @click="acceptAllRevisions(); showRevisionMenu = false" class="px-4 py-2 text-sm cursor-pointer hover:bg-gray-100 text-green-600">✓ 接受所有修订</div>
                            <div @click="rejectAllRevisions(); showRevisionMenu = false" class="px-4 py-2 text-sm cursor-pointer hover:bg-gray-100 text-red-600">✗ 拒绝所有修订</div>
                        </div>
                    </button>
                    <template v-if="cameFromHistory">
                        <button @click="goBackToUpload" class="text-sm font-medium text-primary hover:text-primary-dark">重新上传</button>
                        <button @click="goBackSmart" class="ml-4 text-sm font-medium text-primary hover:text-primary-dark">返回历史</button>
                    </template>
                    <template v-else>
                        <button @click="goBackSmart" class="text-sm font-medium text-primary hover:text-primary-dark">返回上一步</button>
                    </template>
                </div>
            </div>

            <!-- Tab Navigation -->
            <div class="px-4 border-b border-border-color flex-shrink-0">
                <nav class="-mb-px grid grid-cols-4 gap-2">
                    <button @click="activeAiTab = 'summary'" :class="[activeAiTab === 'summary' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">总览</button>
                    <button @click="activeAiTab = 'suggestions'" :class="[activeAiTab === 'suggestions' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">修改</button>
                    <button @click="activeAiTab = 'knowledge'" :class="[activeAiTab === 'knowledge' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">依据</button>
                    <button @click="activeAiTab = 'workspace'" :class="[activeAiTab === 'workspace' ? 'border-primary text-primary bg-primary-light' : 'border-transparent text-text-light hover:text-text-main hover:border-gray-300']" class="whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm rounded-t">工作台</button>
                </nav>
            </div>

            <!-- Tab Content -->
            <div class="p-3 overflow-y-auto flex-grow">
                <!-- 风险仪表盘 (新组件) -->
                <div v-if="activeAiTab === 'summary' && riskDashboardData">
                  <RiskDashboard
                    :overall-score="riskDashboardData.overallScore"
                    :overall-level="riskDashboardData.overallLevel"
                    :overall-label="riskDashboardData.overallLabel"
                    :severity-dist="riskDashboardData.severityDist"
                    :radar-data="riskDashboardData.radarData"
                    :stats="riskDashboardData.stats"
                    :category-risk="riskDashboardData.categoryRisk"
                    :loading="riskScoreLoading"
                    @select-tab="(tab) => activeAiTab = tab"
                  />
                </div>
                <!-- Dispute Points -->
                <div v-if="activeAiTab === 'summary'">
                    <div v-if="reviewData.dispute_points && reviewData.dispute_points.length > 0">
                        <!-- 风险等级过滤 -->
                        <div class="mb-3 flex items-center gap-2 flex-wrap">
                            <span class="text-xs text-text-light">风险等级筛选：</span>
                            <button @click="severityFilter = 'all'" :class="severityFilter === 'all' ? 'bg-primary text-white' : 'bg-white text-text-main border border-border-color'" class="px-2 py-0.5 text-xs rounded">全部 ({{ reviewData.dispute_points.length }})</button>
                            <button v-if="disputeSeverityStats.high" @click="severityFilter = 'high'" :class="severityFilter === 'high' ? 'bg-red-500 text-white' : 'bg-red-50 text-red-700 border border-red-300'" class="px-2 py-0.5 text-xs rounded">高 ({{ disputeSeverityStats.high }})</button>
                            <button v-if="disputeSeverityStats.medium" @click="severityFilter = 'medium'" :class="severityFilter === 'medium' ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 border border-amber-300'" class="px-2 py-0.5 text-xs rounded">中 ({{ disputeSeverityStats.medium }})</button>
                            <button v-if="disputeSeverityStats.low" @click="severityFilter = 'low'" :class="severityFilter === 'low' ? 'bg-blue-500 text-white' : 'bg-blue-50 text-blue-700 border border-blue-300'" class="px-2 py-0.5 text-xs rounded">低 ({{ disputeSeverityStats.low }})</button>
                            <span class="text-xs text-text-light ml-2">已按严重程度从高到低排序</span>
                        </div>
                        <div class="space-y-4">
                            <div v-for="(item, index) in filteredAndSortedDisputePoints" :key="'dp-' + index" :class="['p-4 bg-bg-subtle rounded-md border border-border-color', normalizeSeverity(item.severity) === 'high' ? 'border-l-4 border-l-red-500' : normalizeSeverity(item.severity) === 'medium' ? 'border-l-4 border-l-amber-500' : 'border-l-4 border-l-blue-500']">
                                <div class="flex justify-between items-start gap-2">
                                    <p class="font-semibold text-text-dark">{{ disputeTitle(item, index) }}</p>
                                    <div class="flex items-center gap-2">
                                        <ReviewAnnotations
                                            :contract-id="contract.id"
                                            item-type="dispute_point"
                                            :item-index="index"
                                            :comments="getAnnotations('dispute_point', index)"
                                            :summary="getAnnotationSummary('dispute_point', index)"
                                            :current-user-id="userId"
                                            :open-comment="commentingItemKey === 'dispute_point:' + index"
                                            @add-comment="handleAddAnnotation"
                                            @refresh="commentingItemKey = null"
                                        />
                                        <!-- 书签按钮组（dispute_points 新版审查有书签，存量合同降级为文本定位） -->
                                        <el-tooltip :content="item.titleBookmark ? '定位原文（书签）' : '点击创建书签并定位'" placement="top">
                                            <button
                                                @click="gotoDisputeBookmark(item, index)"
                                                :class="['p-1 transition-colors', item.titleBookmark ? 'text-blue-500 hover:text-blue-700' : 'text-gray-400 hover:text-blue-500']"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                            </button>
                                        </el-tooltip>
                                        <el-tooltip content="点击创建书签并添加原位批注" placement="top">
                                            <button
                                                @click="addReviewCommentByDisputeBookmark(item, index)"
                                                :class="['p-1 transition-colors', item.editBookmark ? 'text-purple-500 hover:text-purple-700' : 'text-gray-400 hover:text-purple-500']"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                                            </button>
                                        </el-tooltip>
                                        <el-tooltip content="点击创建书签并一键调整" placement="top">
                                            <button
                                                @click="adjustReplaceByDisputeBookmark(item, index)"
                                                :class="['p-1 transition-colors', item.editBookmark ? 'text-green-500 hover:text-green-700' : 'text-gray-400 hover:text-green-500']"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                            </button>
                                        </el-tooltip>
                                        <span v-if="item.severity" :class="severityClass(item.severity)" class="px-2 py-0.5 text-xs font-bold rounded border whitespace-nowrap">{{ severityLabel(item.severity) }}</span>
                                    </div>
                                </div>
                                <p v-if="!showPlainLanguage" class="mt-2 text-sm text-text-main whitespace-pre-line">{{ disputeDescription(item) }}</p>
                                <div v-else class="mt-2 p-3 bg-blue-50 text-blue-800 rounded-md border-l-4 border-blue-400">
                                    <p class="text-xs font-bold mb-1">📢 大白话解释：</p>
                                    <p class="text-sm">{{ item.plain_language || disputeDescription(item) }}</p>
                                </div>
                                <div v-if="item.suggested_text" class="mt-3 p-3 bg-green-50 rounded-md border-l-4 border-green-400">
                                    <p class="text-xs font-bold text-green-800 mb-1">💡 修改建议：</p>
                                    <p class="text-sm text-green-900 whitespace-pre-line">{{ item.suggested_text }}</p>
                                    <div v-if="editorEnabled" class="mt-2 flex justify-end">
                                        <button @click="adoptDisputeSuggestion(item)" :disabled="isPdfContract" class="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed">
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                                            采纳建议
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">未发现风险点</div>
                </div>
                <!-- Breach Cost Analysis -->
                <div v-if="activeAiTab === 'summary'">
                    <div v-if="reviewData.breach_cost_analysis && reviewData.breach_cost_analysis.length > 0" class="space-y-4">
                        <div class="p-3 bg-yellow-50 border border-yellow-200 rounded-md text-xs text-yellow-800 flex items-start gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                            <span>以下违约成本由 AI 基于合同文本和法律依据估算，仅供参考，不构成法律意见或赔偿承诺。实际赔偿金额以法院判决或双方协商为准。</span>
                        </div>
                        <div v-for="(item, index) in reviewData.breach_cost_analysis" :key="'bc-' + index" class="p-4 bg-orange-50 rounded-md border border-orange-200">
                            <p class="font-bold text-orange-900 flex items-center">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                违约场景：{{ item.scenario }}
                            </p>
                            <div class="mt-2 text-sm">
                                <p class="text-orange-700 font-medium">依据：</p>
                                <p class="text-orange-800">{{ item.legal_basis }}</p>
                            </div>
                            <div class="mt-3 p-2 bg-white rounded border border-orange-100">
                                <p class="text-xs text-gray-500 font-medium">预计赔偿/成本（仅供参考）：</p>
                                <p class="text-md font-bold text-danger">{{ item.estimated_cost }}</p>
                            </div>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">未发现明确的违约成本条款</div>
                </div>
                <!-- Seal Analysis -->
                <div v-if="activeAiTab === 'summary'">
                    <div v-if="reviewData.seal_analysis && reviewData.seal_analysis.length > 0" class="space-y-4">
                        <div v-for="(item, index) in reviewData.seal_analysis" :key="'seal-' + index" class="p-4 bg-gray-50 rounded-md border border-gray-200">
                            <div class="flex justify-between items-center mb-2">
                                <p class="font-bold text-text-dark">{{ item.seal_name }}</p>
                                <el-tag :type="item.risk_level === '低' ? 'success' : item.risk_level === '中' ? 'warning' : 'danger'" size="small">
                                    风险：{{ item.risk_level }}
                                </el-tag>
                            </div>
                            <div class="mt-2 text-sm flex items-center">
                                <span class="text-gray-500 mr-2">状态:</span>
                                <span :class="item.status === '正常' ? 'text-green-600' : 'text-orange-600'" class="font-medium">{{ item.status }}</span>
                            </div>
                            <p class="mt-2 text-xs text-text-main leading-relaxed">
                                <span class="text-gray-500">检测详情:</span><br/>
                                {{ item.details }}
                            </p>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">未发现印章信息或正在分析中</div>
                </div>
                <!-- Relevant Laws -->
                <div v-if="activeAiTab === 'knowledge'">
                    <div v-if="reviewData.relevant_laws && reviewData.relevant_laws.length > 0" class="space-y-4">
                        <div v-for="(item, index) in reviewData.relevant_laws" :key="'law-' + index" class="p-4 bg-blue-50 rounded-md border border-blue-100">
                            <div class="flex justify-between gap-3">
                                <p class="font-bold text-blue-900">【{{ item.law }}】{{ item.clause }}</p>
                                <el-tag :type="item.hasUpdate ? 'warning' : 'success'" size="small">
                                    {{ item.hasUpdate ? '需关注更新' : '当前可参考' }}
                                </el-tag>
                            </div>
                            <p class="mt-2 text-sm text-blue-900 leading-6">{{ item.content }}</p>
                            <p v-if="item.hasUpdate" class="mt-2 text-xs text-orange-700">{{ item.updateNotice }}</p>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">未命中相关法条</div>
                </div>
                <!-- Missing Clauses -->
                <div v-if="activeAiTab === 'summary'">
                    <div v-if="reviewData.missing_clauses && reviewData.missing_clauses.length > 0" class="space-y-4">
                        <div v-for="(item, index) in reviewData.missing_clauses" :key="'mc-' + index" class="p-4 bg-bg-subtle rounded-md">
                            <div class="flex items-start justify-between">
                                <p class="font-semibold text-text-dark">{{ missingClauseTitle(item, index) }}</p>
                                <ReviewAnnotations
                                    :contract-id="contract.id"
                                    item-type="missing_clause"
                                    :item-index="index"
                                    :comments="getAnnotations('missing_clause', index)"
                                    :summary="getAnnotationSummary('missing_clause', index)"
                                    :current-user-id="userId"
                                    :open-comment="commentingItemKey === 'missing_clause:' + index"
                                    @add-comment="handleAddAnnotation"
                                    @refresh="commentingItemKey = null"
                                />
                            </div>
                            <p class="mt-1 text-sm text-text-main">{{ item.description }}</p>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">未发现缺失条款</div>
                </div>
                <!-- Modification Suggestions -->
                <div v-if="activeAiTab === 'suggestions'">
                    <div v-if="reviewData.modification_suggestions && reviewData.modification_suggestions.length > 0" class="mb-3 flex items-center justify-between gap-2">
                        <el-checkbox-group v-model="selectedSuggestionIndexes" class="flex flex-wrap gap-2">
                            <el-checkbox
                                v-for="(item, index) in reviewData.modification_suggestions"
                                :key="'select-ms-' + index"
                                :label="index"
                                border
                            >{{ index + 1 }}</el-checkbox>
                        </el-checkbox-group>
                        <div class="flex items-center gap-2">
                            <span v-if="isPdfContract" class="text-xs text-amber-600">PDF 不支持采纳</span>
                            <button @click="applySelectedSuggestions" :disabled="batchApplying || isPdfContract || selectedSuggestionIndexes.length === 0" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed">
                                {{ batchApplying ? '批量采纳中...' : '一键采纳所选' }}
                            </button>
                        </div>
                    </div>
                    <div v-if="reviewData.modification_suggestions && reviewData.modification_suggestions.length > 0" class="space-y-4">
                        <div v-for="(item, index) in reviewData.modification_suggestions" :key="'ms-' + index" class="p-4 bg-bg-subtle rounded-md border border-border-color transition-all hover:shadow-md">
                            <div class="flex justify-between items-start">
                                <div class="flex items-center gap-2 flex-1 min-w-0">
                                    <p class="font-semibold text-text-dark pr-2 truncate">{{ suggestionTitle(item, index) }}</p>
                                    <span v-if="item.severity" :class="severityClass(item.severity)" class="px-2 py-0.5 text-xs font-bold rounded border whitespace-nowrap flex-shrink-0">{{ severityLabel(item.severity) }}</span>
                                </div>
                                <div class="flex space-x-1 flex-shrink-0">
                                    <ReviewAnnotations
                                        :contract-id="contract.id"
                                        item-type="suggestion"
                                        :item-index="index"
                                        :comments="getAnnotations('suggestion', index)"
                                        :summary="getAnnotationSummary('suggestion', index)"
                                        :current-user-id="userId"
                                        :open-comment="commentingItemKey === 'suggestion:' + index"
                                        @add-comment="handleAddAnnotation"
                                        @refresh="commentingItemKey = null"
                                    />
                                    <el-tooltip content="在文档中定位" placement="top">
                                        <button @click="locateText(suggestionOriginal(item), 'suggestion', index)" class="p-1 text-gray-400 hover:text-primary transition-colors">
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                        </button>
                                    </el-tooltip>
                                    <el-tooltip content="添加批注" placement="top">
                                        <button @click="addDocComment(suggestionOriginal(item), suggestionReason(item), 'suggestion', index)" class="p-1 text-gray-400 hover:text-primary transition-colors">
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" /></svg>
                                        </button>
                                    </el-tooltip>
                                    <!-- 星法2.0 书签按钮组（始终可点击，按需创建书签） -->
                                    <el-tooltip content="定位原文" placement="top">
                                        <button
                                          @click="wpsEditorRef?.gotoBookmark(item.titleBookmark, item)"
                                          class="p-1 text-blue-500 hover:text-blue-700 transition-colors"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                        </button>
                                    </el-tooltip>
                                    <el-tooltip content="原位批注" placement="top">
                                        <button
                                          @click="wpsEditorRef?.addReviewCommentByBookmarkWps(item.editBookmark, {action: item.action || 'replace', target_text: item.original_text, actionText: '建议修改为', new_text: item.suggested_text || item.modification}, item.id || index, item)"
                                          class="p-1 text-purple-500 hover:text-purple-700 transition-colors"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                                        </button>
                                    </el-tooltip>
                                    <el-tooltip content="一键修订" placement="top">
                                        <button
                                          @click="wpsEditorRef?.adjustReplaceByBookmarkWps(item.editBookmark, {action: item.action || 'replace', target_text: item.original_text, new_text: item.suggested_text || item.modification}, item.id || index, item)"
                                          class="p-1 text-green-500 hover:text-green-700 transition-colors"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                        </button>
                                    </el-tooltip>
                                </div>
                            </div>

                            <div v-if="showPlainLanguage" class="mt-3 p-3 bg-green-50 text-green-800 rounded-md border-l-4 border-green-400">
                                <p class="text-xs font-bold mb-1">📢 大白话建议：</p>
                                <p class="text-sm">{{ item.plain_language || suggestionReason(item) }}</p>
                            </div>

                            <div v-else class="space-y-3 mt-3">
                                <div class="text-xs">
                                    <p class="text-gray-500 font-medium">原文：</p>
                                    <blockquote class="mt-1 p-2 bg-red-50 text-red-800 border-l-4 border-red-400 break-all">
                                        {{ suggestionOriginal(item) || 'AI 未返回可直接定位的原文，请参考建议条款手动核对。' }}
                                    </blockquote>
                                </div>
                                <div class="text-xs">
                                    <p class="text-gray-500 font-medium">建议：</p>
                                    <blockquote
                                        :title="item.adopted ? `采纳前原文：${item.adopted_original || suggestionOriginal(item)}` : ''"
                                        :class="[
                                            'mt-1 p-2 text-green-800 border-l-4 border-green-400 break-all',
                                            item.adopted ? 'adopted-suggestion-text' : 'bg-green-50'
                                        ]"
                                    >
                                        {{ suggestionText(item) }}
                                    </blockquote>
                                </div>
                                <div class="text-xs">
                                    <p class="text-gray-500 font-medium">理由：</p>
                                    <p class="mt-1 text-text-main">{{ suggestionReason(item) }}</p>
                                </div>
                                <div v-if="item.citations && item.citations.length" class="text-xs">
                                    <p class="text-gray-500 font-medium">法律依据：</p>
                                    <div v-for="(cite, cIndex) in item.citations" :key="'cite-' + index + '-' + cIndex" class="mt-1 p-2 bg-blue-50 border-l-4 border-blue-300 rounded">
                                        <p class="font-medium text-blue-800">【{{ cite.source_type || '依据' }}】{{ cite.title || '' }}{{ cite.clause ? ' ' + cite.clause : '' }}</p>
                                        <p v-if="cite.content" class="mt-0.5 text-blue-700">{{ cite.content }}</p>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="mt-4 pt-3 border-t border-gray-100 flex justify-end items-center">
                                <span v-if="isPdfContract" class="mr-2 text-xs text-amber-600">PDF 文件不支持原文改写，请使用审查报告导出或 PDF 批注</span>
                                <button @click="previewSuggestion(item)" class="mr-2 px-3 py-1.5 text-xs font-medium text-primary bg-white border border-primary rounded hover:bg-primary-light transition-colors">
                                    查看变更
                                </button>
                                <button @click="adoptSuggestion(item)" :disabled="isPdfContract || item.adopted" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                                    {{ item.adopted ? '已采纳' : '一键采纳建议' }}
                                </button>
                            </div>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">未发现修改建议</div>
                </div>
                <!-- Party Review -->
                <div v-if="activeAiTab === 'summary'">
                     <div v-if="reviewData.party_review && reviewData.party_review.length > 0" class="space-y-4">
                        <div v-for="(item, index) in reviewData.party_review" :key="'pr-' + index" class="p-4 bg-bg-subtle rounded-md">
                            <p class="font-semibold text-text-dark">{{ partyReviewTitle(item, index) }}</p>
                            <p class="mt-1 text-sm text-text-main whitespace-pre-line">{{ partyReviewDescription(item) }}</p>
                        </div>
                    </div>
                    <div v-else class="text-center text-text-light py-8">主体信息无风险</div>
                </div>
                <div v-if="activeAiTab === 'summary' && reviewData.company_review && reviewData.company_review.length > 0" class="mt-4 space-y-4">
                    <div v-for="(item, index) in reviewData.company_review" :key="'company-' + index" class="p-4 bg-white rounded-md border border-border-color">
                        <div class="flex items-start justify-between gap-3">
                            <div>
                                <p class="font-semibold text-text-dark">{{ item.company_name || item.title || '主体审查' }}</p>
                                <p class="mt-1 text-sm text-text-main">{{ item.status || item.evidence_summary }}</p>
                            </div>
                            <el-tag size="small" :type="String(item.authenticity || '').includes('未') ? 'warning' : 'success'">外部检索</el-tag>
                        </div>
                        <p v-if="item.evidence_summary" class="mt-2 text-sm text-text-main whitespace-pre-line">{{ item.evidence_summary }}</p>
                        <p v-if="item.authenticity" class="mt-2 text-xs text-text-light">{{ item.authenticity }}</p>
                        <div v-if="item.sources && item.sources.length" class="mt-2 flex flex-col gap-1">
                            <a v-for="source in item.sources" :key="source" :href="source" target="_blank" rel="noreferrer" class="text-xs text-primary hover:underline truncate">{{ source }}</a>
                        </div>
                    </div>
                </div>
                <!-- Focused Review -->
                <div v-if="activeAiTab === 'workspace'">
                    <div class="space-y-4">
                        <div class="p-4 bg-white rounded-md border border-border-color">
                            <div class="flex items-center justify-between">
                                <h4 class="font-semibold text-text-dark">合同版本对比</h4>
                                <button @click="loadLatestDiff" :disabled="diffLoading" class="px-3 py-1.5 text-xs font-medium text-primary bg-white border border-primary rounded hover:bg-primary-light">
                                    {{ diffLoading ? '加载中...' : '查看最近变更' }}
                                </button>
                            </div>
                            <div v-if="diffItems.length" class="mt-3 p-3 bg-bg-subtle rounded text-xs leading-6 max-h-56 overflow-y-auto whitespace-pre-wrap">
                                <template v-for="(part, index) in diffItems" :key="'diff-' + index">
                                    <span v-if="part.type === 'insert'" class="diff-insert">{{ part.text }}</span>
                                    <span v-else-if="part.type === 'delete'" class="diff-delete">{{ part.text }}</span>
                                    <span v-else>{{ part.text }}</span>
                                </template>
                            </div>
                            <p v-else class="mt-2 text-xs text-text-light">采纳修改后会自动保存原始快照，可在这里查看新增和删除文本。</p>
                        </div>
                        <div class="p-4 bg-bg-subtle rounded-md border border-border-color">
                            <div class="flex justify-between items-center">
                                <h4 class="font-semibold text-text-dark">选中文本专项审查</h4>
                                <button @click="prepareFocusedReviewFromSelection" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark">
                                    从左侧读取选中文本
                                </button>
                            </div>
                            <el-input
                                v-model="focusedReviewText"
                                class="mt-3"
                                type="textarea"
                                :rows="6"
                                placeholder="可从左侧 WPS 编辑器选中文本后读取，也可手动粘贴某一条款或段落"
                            />
                            <el-input
                                v-model="focusedReviewQuestion"
                                class="mt-3"
                                placeholder="专项问题，例如：审查这段试用期条款是否合法，并给出可替换文本"
                            />
                            <div class="mt-3 flex justify-end">
                                <button @click="submitFocusedReview" :disabled="focusedReviewLoading || !focusedReviewText.trim()" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded hover:bg-primary-dark disabled:opacity-50">
                                    {{ focusedReviewLoading ? '审查中...' : '开始专项审查' }}
                                </button>
                            </div>
                        </div>

                        <div v-if="focusedReviewResult" class="p-4 bg-white rounded-md border border-border-color">
                            <p class="font-semibold text-text-dark">专项审查结论</p>
                            <p class="mt-2 text-sm text-text-main whitespace-pre-line">{{ focusedReviewResult.risk_summary }}</p>
                            <div v-if="focusedReviewResult.plain_language" class="mt-3 p-3 bg-blue-50 text-blue-800 border-l-4 border-blue-400 rounded">
                                <p class="text-xs font-bold mb-1">大白话说明</p>
                                <p class="text-sm">{{ focusedReviewResult.plain_language }}</p>
                            </div>
                            <div v-if="focusedReviewResult.suggested_text" class="mt-3">
                                <p class="text-xs text-gray-500 font-medium">建议替换文本</p>
                                <p class="mt-1 p-2 bg-green-50 text-green-800 border border-green-100 rounded whitespace-pre-line">{{ focusedReviewResult.suggested_text }}</p>
                                <button @click="applyFocusedSuggestion" class="mt-3 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark">
                                    替换左侧选中文本
                                </button>
                            </div>
                            <div v-if="focusedReviewResult.relevant_laws && focusedReviewResult.relevant_laws.length" class="mt-3">
                                <p class="text-xs text-gray-500 font-medium">检索依据</p>
                                <div v-for="(item, index) in focusedReviewResult.relevant_laws" :key="'fr-law-' + index" class="mt-2 p-2 bg-bg-subtle rounded text-xs">
                                    【{{ item.law }}】{{ item.clause }}：{{ item.content }}
                                </div>
                            </div>
                        </div>

                        <!-- 专项审查历史 -->
                        <div v-if="focusedReviewHistory.length" class="p-4 bg-white rounded-md border border-border-color">
                            <div class="flex justify-between items-center">
                                <p class="font-semibold text-text-dark text-sm">历史专项审查（已持久化，刷新不丢失）</p>
                                <span class="text-xs text-text-light">{{ focusedReviewHistory.length }} 条</span>
                            </div>
                            <div class="mt-2 space-y-2 max-h-72 overflow-y-auto">
                                <div v-for="item in focusedReviewHistory" :key="'fr-h-' + item.id" class="p-2 bg-bg-subtle rounded text-xs border border-transparent hover:border-primary transition-colors">
                                    <div class="flex justify-between items-start gap-2">
                                        <div class="flex-1 min-w-0">
                                            <p class="text-text-main font-medium truncate">{{ item.question || '（无专项问题）' }}</p>
                                            <p class="text-text-light mt-0.5 truncate">原文：{{ item.source_text }}</p>
                                            <p class="text-text-light mt-0.5">{{ formatHistoryTime(item.created_at) }}</p>
                                        </div>
                                        <div class="flex gap-1 flex-shrink-0">
                                            <button @click="loadFocusedReviewFromHistory(item)" class="px-2 py-1 text-xs text-primary border border-primary rounded hover:bg-primary hover:text-white">查看</button>
                                            <button @click="deleteFocusedReviewFromHistory(item.id)" class="px-2 py-1 text-xs text-red-500 border border-red-300 rounded hover:bg-red-500 hover:text-white">删除</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- Re-review Form -->
                <div v-if="activeAiTab === 'workspace'">
                   <div class="space-y-6">
                        <div>
                            <label class="block text-sm font-medium text-text-main">合同类型</label>
                            <el-input v-model="preAnalysisData.contract_type" class="mt-1"></el-input>
                        </div>
                        <div>
                             <label class="block text-sm font-medium text-text-main">审查立场</label>
                             <el-select v-model="perspective" placeholder="请选择或输入您的立场" class="w-full mt-1" filterable allow-create>
                                <el-option v-for="party in allPotentialParties" :key="party" :label="party" :value="party"></el-option>
                             </el-select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-text-main">审查点选择</label>
                             <div class="mt-2 p-3 bg-bg-subtle rounded-md">
                                <el-checkbox-group v-model="selectedReviewPoints" class="flex flex-wrap gap-2">
                                    <el-checkbox v-for="point in allSuggestedReviewPoints" :key="point" :label="point" :value="point" border></el-checkbox>
                                </el-checkbox-group>
                             </div>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-text-main">审查核心目的</label>
                             <div v-for="(purpose, index) in customPurposes" :key="index" class="flex items-center mt-1">
                                <el-autocomplete
                                    v-model="purpose.value"
                                    :fetch-suggestions="querySearchCorePurposes"
                                    placeholder="搜索或输入新目的"
                                    class="w-full"
                                    trigger-on-focus
                                ></el-autocomplete>
                                <button @click="removePurpose(index)" class="ml-2 text-gray-400 hover:text-danger"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></button>
                            </div>
                            <button @click="addPurpose" class="mt-2 text-sm font-medium text-primary hover:text-primary-dark flex items-center">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                添加目的
                            </button>
                        </div>
                        <div class="pt-4">
                            <button
                                @click="startReAnalysis"
                                :disabled="!perspective || selectedReviewPoints.length === 0 || reAnalyzing"
                                class="w-full px-4 py-2 text-sm font-medium text-white bg-primary border border-transparent rounded-md shadow-sm hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {{ reAnalyzing ? '正在重审...' : '确认重审' }}
                            </button>
                        </div>
                        <!-- 重审进度面板 -->
                        <div v-if="reAnalyzing || analysisActive" class="reanalysis-progress p-4 bg-white rounded-md border border-border-color">
                            <div class="flex items-center justify-between mb-2">
                                <span class="text-sm font-semibold text-text-dark">{{ loadingMessage || '正在重新审查合同...' }}</span>
                                <span v-if="analysisPercent > 0" class="analysis-percent-counter text-lg font-bold text-primary">{{ analysisPercent }}%</span>
                            </div>
                            <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden mb-2">
                                <div class="analysis-progress-bar-shimmer h-2 rounded-full transition-all duration-500 ease-out" :style="{ width: analysisPercent + '%' }"></div>
                            </div>
                            <div class="flex justify-between text-xs text-text-light mb-3">
                                <span>已用时：{{ formatDuration(analysisElapsed) }}</span>
                            </div>
                            <div v-if="analysisSteps.length" class="analysis-progress mt-2 w-full">
                                <div
                                    v-for="(step, index) in analysisSteps"
                                    :key="'re-step-' + index"
                                    class="analysis-progress__item"
                                    :class="[`analysis-progress__item--${progressStatusClass(step.status)}`]"
                                >
                                    <div class="analysis-progress__marker">
                                        <span v-if="step.status === 'completed'">✓</span>
                                        <span v-else-if="step.status === 'failed'">!</span>
                                        <span v-else-if="step.status === 'running'" class="analysis-progress__spinner"></span>
                                        <span v-else>{{ index + 1 }}</span>
                                    </div>
                                    <div class="analysis-progress__content">
                                        <div class="analysis-progress__title">
                                            <span>{{ step.label }}</span>
                                            <span v-if="step.status === 'running'" class="analysis-thinking-dots"><span></span><span></span><span></span></span>
                                            <span v-else class="analysis-progress__status">{{ progressStatusLabel(step.status) }}</span>
                                        </div>
                                        <p v-if="step.message" class="analysis-progress__message">{{ step.message }}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                   </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Loading Overlay - Moved inside the single root element -->
    <div v-if="loading && activeStep < 2" class="fixed inset-0 bg-white/70 backdrop-blur-sm flex items-center justify-center z-50">
        <div class="flex flex-col items-center max-w-lg bg-white border border-border-color rounded-md p-6 shadow-sm w-full mx-4">
            <div class="flex items-center justify-between w-full mb-3">
                <p class="text-lg font-semibold text-text-dark">{{ loadingMessage }}</p>
                <span v-if="analysisPercent > 0" class="analysis-percent-counter text-2xl font-bold text-primary">{{ analysisPercent }}%</span>
            </div>

            <!-- 进度条 -->
            <div v-if="analysisActive" class="w-full mb-3">
                <div class="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                    <div class="analysis-progress-bar-shimmer h-2.5 rounded-full transition-all duration-500 ease-out" :style="{ width: analysisPercent + '%' }"></div>
                </div>
                <div class="flex justify-between text-xs text-text-light mt-1">
                    <span>已用时：{{ formatDuration(analysisElapsed) }}</span>
                </div>
            </div>

            <!-- 步骤列表 -->
            <div v-if="analysisSteps.length" class="analysis-progress mt-2 w-full">
                <div
                    v-for="(step, index) in analysisSteps"
                    :key="'step-' + index"
                    class="analysis-progress__item"
                    :class="[
                        `analysis-progress__item--${progressStatusClass(step.status)}`,
                    ]"
                >
                    <div class="analysis-progress__marker">
                        <span v-if="step.status === 'completed'">✓</span>
                        <span v-else-if="step.status === 'failed'">!</span>
                        <span v-else-if="step.status === 'running'" class="analysis-progress__spinner"></span>
                        <span v-else>{{ index + 1 }}</span>
                    </div>
                    <div class="analysis-progress__content">
                        <div class="analysis-progress__title">
                            <span>{{ step.label }}</span>
                            <span v-if="step.status === 'running'" class="analysis-thinking-dots"><span></span><span></span><span></span></span>
                            <span v-else class="analysis-progress__status">{{ progressStatusLabel(step.status) }}</span>
                        </div>
                        <p v-if="step.message" class="analysis-progress__message">{{ step.message }}</p>
                    </div>
                </div>
            </div>
            <!-- 兼容旧版进度事件（无 steps 结构时） -->
            <div v-else-if="analysisProgress.length" class="analysis-progress mt-4 w-full">
                <div
                    v-for="(item, index) in visibleAnalysisProgress"
                    :key="'progress-' + index"
                    class="analysis-progress__item"
                    :class="[
                        `analysis-progress__item--${progressStatusClass(item.status)}`,
                        index === visibleAnalysisProgress.length - 1 ? 'analysis-progress__item--current' : ''
                    ]"
                >
                    <div class="analysis-progress__marker">
                        <span v-if="item.status === 'completed'">✓</span>
                        <span v-else-if="item.status === 'failed'">!</span>
                    </div>
                    <div class="analysis-progress__content">
                        <div class="analysis-progress__title">
                            <span>{{ progressStepLabel(item.step) }}</span>
                            <span class="analysis-progress__status">{{ progressStatusLabel(item.status) }}</span>
                        </div>
                        <p v-if="item.message" class="analysis-progress__message">{{ item.message }}</p>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- 会话恢复失败重试遮罩 -->
    <div v-if="sessionLoadFailed" class="fixed inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center z-50">
        <div class="flex flex-col items-center max-w-md bg-white border border-border-color rounded-md p-6 shadow-md w-full mx-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 text-amber-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            <p class="text-lg font-semibold text-text-dark mb-1">恢复会话失败</p>
            <p class="text-sm text-text-light text-center mb-4">可能是网络连接问题导致无法加载合同详情。您的审查进度已保留，可点击下方按钮重试，或返回首页。</p>
            <div class="flex gap-3">
                <button @click="retryLoadSession" class="px-4 py-2 text-sm font-medium text-white bg-primary rounded hover:bg-primary-dark">重试恢复</button>
                <button @click="sessionLoadFailed = false; resetState();" class="px-4 py-2 text-sm font-medium text-text-main bg-white border border-border-color rounded hover:bg-bg-subtle">放弃并重置</button>
            </div>
        </div>
    </div>

    <!-- Inline Q&A Chat Widget -->
    <div v-if="activeStep === 2" class="qa-chat-widget" :class="{ 'qa-chat-widget--open': qaPanelOpen }">
        <div v-if="!qaPanelOpen" class="qa-chat-widget__fab" @click="toggleQaPanel">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            <span class="qa-chat-widget__fab-badge" v-if="qaMessages.length">智能问答</span>
            <span class="qa-chat-widget__fab-badge" v-else>智能问答</span>
        </div>
        <div v-else class="qa-chat-widget__panel">
            <div class="qa-chat-widget__header">
                <div class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    <span class="font-semibold text-sm text-text-dark">智能问答</span>
                    <span v-if="contract.id" class="text-xs text-text-light">已关联：{{ contract.original_filename }}</span>
                </div>
                <div class="flex items-center gap-1">
                    <button v-if="qaMessages.length" @click="clearQaChat" title="清空会话" class="text-gray-400 hover:text-red-500 p-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                    <button @click="toggleQaPanel" title="关闭" class="text-gray-400 hover:text-text-dark p-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
            </div>
            <div ref="qaChatBody" class="qa-chat-widget__body">
                <div v-if="qaMessages.length === 0" class="qa-chat-widget__empty">
                    <p class="text-sm text-text-light">输入问题，AI 将基于当前合同为您解答。</p>
                    <p class="text-xs text-text-light mt-1">例如：试用期超过法定期限怎么处理？</p>
                </div>
                <div v-for="(msg, index) in qaMessages" :key="'qa-' + index" class="qa-chat-widget__msg" :class="'qa-chat-widget__msg--' + msg.role">
                    <div class="qa-chat-widget__bubble">
                        <p class="qa-chat-widget__role">{{ msg.role === 'user' ? '你' : 'AI 助手' }}</p>
                        <div class="qa-chat-widget__content" v-html="renderQaMarkdown(msg.content || '正在生成...')"></div>
                    </div>
                </div>
                <div v-if="qaLoading" class="qa-chat-widget__typing">
                    <span></span><span></span><span></span>
                </div>
            </div>
            <div class="qa-chat-widget__footer">
                <el-input
                    v-model="qaInput"
                    type="textarea"
                    :rows="2"
                    placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                    resize="none"
                    :disabled="qaLoading"
                    @keydown.enter.prevent="handleQaEnter"
                />
                <button @click="sendQaMessage" :disabled="!qaInput.trim() || qaLoading" class="qa-chat-widget__send">
                    发送
                </button>
            </div>
        </div>
    </div>
  </div>
</template>

<script>
import { ref, shallowRef, reactive, watch, toRaw, onMounted, nextTick, onUnmounted, computed, triggerRef } from 'vue';
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router';
import { ElMessage, ElUpload, ElSelect, ElOption, ElCheckboxGroup, ElCheckbox, ElInput, ElAutocomplete, ElSwitch, ElTooltip } from 'element-plus';
import { marked } from 'marked';
import { v4 as uuidv4 } from 'uuid';
import { io } from 'socket.io-client';
import api from '../api';
import { getUserId } from '../user';
import WpsEditor from '@/components/WpsEditor.vue';
import RiskDashboard from '@/components/RiskDashboard.vue';
import ReviewAnnotations from '@/components/ReviewAnnotations.vue';

export default {
  name: 'ReviewView',
  components: {
    WpsEditor,
    RiskDashboard,
    ReviewAnnotations,
    ElUpload, ElSelect, ElOption, ElCheckboxGroup, ElCheckbox, ElInput, ElAutocomplete, ElSwitch, ElTooltip
  },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const activeStep = ref(0);
    let isResetting = false; // The flag to prevent watchers from firing during reset
    const cameFromHistory = ref(false);
    const loading = ref(false);
    const loadingMessage = ref('');
    const sessionLoadFailed = ref(false);
    const preAnalyzing = ref(false);
    const perspective = ref('');
    const activeAiTab = ref('summary');
    const wpsMountRef = ref(null);
    const wpsInstance = ref(null);
    const wpsApp = ref(null);
    const isEditorReady = ref(false);
    const socket = ref(null);
    const reAnalyzing = ref(false);
    const showPlainLanguage = ref(false);
    const showRevisionMenu = ref(false);
    const forceSaveTimer = ref(null);
    const forceSaveDebounceTimer = ref(null);
    const forceSaveInFlight = ref(false);
    const hasPendingEditorChanges = ref(false);
    const selectedSuggestionPreview = ref(null);
    const adoptedHighlights = ref({});
    const analysisProgress = ref([]);
    const selectedSuggestionIndexes = ref([]);
    const batchApplying = ref(false);
    // --- Full-provider: Left Panel Enhancement ---
    const showVersionHistory = ref(false);
    const versionHistory = ref([]);
    const versionHistoryLoading = ref(false);
    const showWatermarkMenu = ref(false);
    const watermarkEnabled = ref(true);
    const watermarkText = ref('');
    const diffItems = ref([]);
    const diffLoading = ref(false);
    const linkedGroupFiles = ref([]);
    const linkedAnalysisLoading = ref(false);
    const linkedAnalysisResult = ref(null);
    const linkedAnalysisProgress = ref([]);
    const linkedFileInput = ref(null);
    const versionHistoryDropdown = ref(null);
    const watermarkDropdown = ref(null);
    const visibleAnalysisProgress = computed(() => analysisProgress.value.slice(-6));
    // 控制当前哪个建议项的批注面板应打开（key = "type:index"）
    const commentingItemKey = ref(null);
    // 判断当前合同是否为 PDF（PDF 不支持原文改写/采纳）
    const isPdfContract = computed(() => {
        const name = String(contract.original_filename || '').toLowerCase();
        return name.endsWith('.pdf');
    });
    // WPS 编辑器模式：当前用户是否为合同所有者（edit 模式 vs simple 模式）
    const userId = computed(() => getUserId());
    const editMode = computed(() => {
        const uid = String(userId.value || '');
        return contract.value?.user_id?.toString() === uid ? 'edit' : 'simple';
    });
    // WPS 编辑器错误处理
    const onEditorError = (error) => {
        console.error('[WPS Editor] Error:', error);
        ElMessage.error('WPS 编辑器错误: ' + (error.message || '未知错误'));
    };
    const progressStepLabels = {
      pre_analysis: '合同预分析',
      extract_text: '提取合同正文',
      knowledge_search: '检索法条与案例',
      company_search: '核验合同主体',
      llm_review: '生成审查结论',
      seal_analysis: '印章与签章核验',
      finalize: '保存审查结果',
      failed: '分析失败',
    };
    const progressStatusLabels = {
      running: '进行中',
      completed: '已完成',
      failed: '失败',
      pending: '等待中',
      reviewed: '已审查',
      pre_analyzed: '已预分析',
      processing: '处理中',
      queued: '排队中',
    };
    const progressStepLabel = (step) => progressStepLabels[step] || step || '处理中';
    const progressStatusLabel = (status) => progressStatusLabels[status] || status || '处理中';
    const progressStatusClass = (status) => {
      if (status === 'completed' || status === 'reviewed' || status === 'pre_analyzed') return 'completed';
      if (status === 'failed') return 'failed';
      if (status === 'running') return 'running';
      return 'pending';
    };

    // 异步分析进度追踪状态
    const analysisPercent = ref(0);
    const analysisEta = ref(0);
    const analysisElapsed = ref(0);
    const analysisJobId = ref(null);
    const analysisSteps = ref([]);
    const statusPollTimer = ref(null);
    const analysisActive = ref(false);
    const elapsedTimer = ref(null); // 本地实时计时器

    // 启动本地实时计时器（秒级更新）
    const startElapsedTimer = () => {
      stopElapsedTimer();
      elapsedTimer.value = setInterval(() => {
        if (analysisActive.value) {
          analysisElapsed.value += 1;
        }
      }, 1000);
    };
    const stopElapsedTimer = () => {
      if (elapsedTimer.value) {
        clearInterval(elapsedTimer.value);
        elapsedTimer.value = null;
      }
    };

    const formatDuration = (seconds) => {
      if (!seconds || seconds < 0) return '0秒';
      if (seconds < 60) return `${seconds}秒`;
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return s > 0 ? `${m}分${s}秒` : `${m}分`;
    };
    const focusedReviewText = ref('');
    const focusedReviewQuestion = ref('');
    const focusedReviewResult = ref(null);
    const focusedReviewLoading = ref(false);
    const focusedReviewHistory = ref([]);
    const focusedReviewHistoryLoading = ref(false);
    // 风险点 severity 排序与过滤
    const severityFilter = ref('all'); // all | high | medium | low
    const severityOrder = { high: 0, '高': 0, medium: 1, '中': 1, low: 2, '低': 2 };
    const normalizeSeverity = (s) => {
        const v = String(s || '').toLowerCase().trim();
        if (['high', '高', '严重', 'critical'].includes(v)) return 'high';
        if (['medium', '中', '一般', 'moderate'].includes(v)) return 'medium';
        if (['low', '低', '轻微', 'minor'].includes(v)) return 'low';
        return 'medium';
    };
    const severityLabel = (s) => {
        const n = normalizeSeverity(s);
        return { high: '高', medium: '中', low: '低' }[n];
    };
    const severityClass = (s) => {
        const n = normalizeSeverity(s);
        return {
            high: 'bg-red-100 text-red-700 border-red-300',
            medium: 'bg-amber-100 text-amber-700 border-amber-300',
            low: 'bg-blue-100 text-blue-700 border-blue-300',
        }[n];
    };
    const filteredAndSortedDisputePoints = computed(() => {
        const list = reviewData.dispute_points || [];
        const filtered = severityFilter.value === 'all'
            ? list
            : list.filter((item) => normalizeSeverity(item.severity) === severityFilter.value);
        return [...filtered].sort((a, b) => {
            const sa = severityOrder[normalizeSeverity(a.severity)] ?? 1;
            const sb = severityOrder[normalizeSeverity(b.severity)] ?? 1;
            return sa - sb;
        });
    });
    const disputeSeverityStats = computed(() => {
        const list = reviewData.dispute_points || [];
        const stats = { high: 0, medium: 0, low: 0 };
        list.forEach((item) => { stats[normalizeSeverity(item.severity)] += 1; });
        return stats;
    });
    // 风险仪表盘：整体风险等级 + 各模块统计
    const riskDashboard = computed(() => {
        const disputes = reviewData.dispute_points || [];
        const missing = reviewData.missing_clauses || [];
        const breach = reviewData.breach_cost_analysis || [];
        const party = reviewData.party_review || [];
        const suggestions = reviewData.modification_suggestions || [];
        const stats = disputeSeverityStats.value;
        const total = disputes.length;
        // 整体风险等级：有高危即为高，否则有中危即为中，否则低
        let overallLevel = 'low';
        let overallLabel = '低';
        let overallClass = 'bg-green-100 text-green-700 border-green-300';
        if (stats.high > 0) {
            overallLevel = 'high';
            overallLabel = '高';
            overallClass = 'bg-red-100 text-red-700 border-red-300';
        } else if (stats.medium > 0) {
            overallLevel = 'medium';
            overallLabel = '中';
            overallClass = 'bg-amber-100 text-amber-700 border-amber-300';
        }
        return {
            total,
            stats,
            overallLevel,
            overallLabel,
            overallClass,
            moduleCounts: {
                disputes: total,
                missing: missing.length,
                breach: breach.length,
                party: party.length,
                suggestions: suggestions.length,
            },
        };
    });
    const reviewTemplates = ref([]);
    const selectedTemplateId = ref('general');

    const allSuggestedReviewPoints = ref([]);
    const allPotentialParties = ref([]);
    const allSuggestedCorePurposes = ref([]);

    const initialContractState = {
      id: null,
      original_filename: '',
      editorConfig: null,
    };
    const contract = reactive({ ...initialContractState });

    const setupSocket = (contractId) => {
        if (socket.value) socket.value.disconnect();
        
        const backendUrl = import.meta.env.VITE_APP_BACKEND_API_URL || 'http://localhost:3000';
        socket.value = io(backendUrl);

        socket.value.on('connect', () => {
            console.log('Connected to collaboration server');
            socket.value.emit('join-contract', contractId);
        });

        socket.value.on('connect_error', (error) => {
            console.error('Collaboration server connection failed:', error.message);
        });

        socket.value.on('analysis-complete', (data) => {
            console.log('Received real-time analysis update');
            analysisActive.value = false;
            analysisPercent.value = 100;
            reAnalyzing.value = false;
            stopStatusPolling();
            stopElapsedTimer();
            ElMessage.success({
                message: `审查完成（立场：${data.perspective || '未指定'}）。`,
                duration: 3000
            });
            Object.assign(reviewData, data.results || data);
            if (data.perspective) perspective.value = data.perspective;
            loading.value = false;
            activeStep.value = 2;
            loadRiskScore();
            loadAnnotations();
            // 如果后端返回了新配置（批注已写入文件），刷新编辑器
            if (data.newEditorConfig) {
                contract.editorConfig = { ...data.newEditorConfig };
                ElMessage.success('批注已嵌入文档，正在重新加载简化编辑界面...');
            } else if (reviewData.modification_suggestions?.length > 0) {
                // 后端没有写入批注到文档，前端需要在文档加载后自动插入
                needsAutoInsert.value = true;
            }
        });

        socket.value.on('analysis-progress', (data) => {
            analysisProgress.value.push(data);
            if (typeof data.percent === 'number') analysisPercent.value = data.percent;
            if (typeof data.elapsedSeconds === 'number') analysisElapsed.value = data.elapsedSeconds;
            if (Array.isArray(data.steps)) {
                analysisSteps.value = data.steps;
            } else if (data.step && data.status) {
                // 后端推送的是单步进度事件，更新对应步骤的状态
                const stepKey = data.step;
                const stepStatus = data.status;
                analysisSteps.value = analysisSteps.value.map((s) =>
                    s.key === stepKey ? { ...s, status: stepStatus, message: data.message || s.message || '' } : s
                );
            }
            if (data.partialResult) {
                Object.assign(reviewData, data.partialResult);
            }
            loadingMessage.value = data.message || loadingMessage.value;
        });

        socket.value.on('analysis-failed', (data) => {
            analysisActive.value = false;
            loading.value = false;
            reAnalyzing.value = false;
            stopStatusPolling();
            stopElapsedTimer();
            ElMessage.error(data?.error || '分析失败，请稍后重试');
        });

        socket.value.on('disconnect', () => {
            // 断线时启动轮询恢复，保持进度更新
            // 注意：不重置任何状态，只追加轮询作为兜底
            if (analysisActive.value || reAnalyzing.value) {
                startStatusPolling();
            }
        });
    };

    const preAnalysisData = reactive({
      contract_type: '',
      potential_parties: [],
      suggested_review_points: [],
      suggested_core_purposes: [],
      template_id: '',
      template_name: '',
    });
    const showContractPreview = ref(false);
    const contractPreviewText = computed(() => {
        const preview = preAnalysisData.text_stats?.preview;
        if (preview) return preview;
        return '暂无预览内容。';
    });
    // --- Inline Q&A Chat Widget ---
    const qaPanelOpen = ref(false);
    const qaInput = ref('');
    const qaMessages = ref([]);
    const qaLoading = ref(false);
    const qaChatBody = ref(null);
    const qaSessionId = ref(localStorage.getItem('qa_session_id') || uuidv4());
    if (!localStorage.getItem('qa_session_id')) {
        localStorage.setItem('qa_session_id', qaSessionId.value);
    }
    const escapeQaHtml = (text) => String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const renderQaMarkdown = (text) => marked.parse(escapeQaHtml(text));
    const scrollQaToBottom = async () => {
        await nextTick();
        if (qaChatBody.value) qaChatBody.value.scrollTop = qaChatBody.value.scrollHeight;
    };
    const toggleQaPanel = async () => {
        qaPanelOpen.value = !qaPanelOpen.value;
        if (qaPanelOpen.value) {
            await scrollQaToBottom();
        }
    };
    const parseQaSseEvent = (eventText) => {
        const eventLine = eventText.split('\n').find((line) => line.startsWith('event:'));
        const dataLines = eventText
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.replace('data:', '').trim());
        if (!dataLines.length) return null;
        return {
            event: eventLine?.replace('event:', '').trim(),
            data: JSON.parse(dataLines.join('\n')),
        };
    };
    const buildQaHistory = () => qaMessages.value
        .filter((m) => ['user', 'assistant'].includes(m.role) && String(m.content || '').trim())
        .slice(-12)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }));
    const sendQaMessage = async () => {
        if (!qaInput.value.trim() || qaLoading.value) return;
        const question = qaInput.value.trim();
        const history = buildQaHistory();
        qaInput.value = '';
        qaMessages.value.push({ role: 'user', content: question });
        // 使用索引通过响应式数组修改消息，确保打字机效果实时渲染
        const assistantIdx = qaMessages.value.length;
        qaMessages.value.push({ role: 'assistant', content: '' });
        await scrollQaToBottom();
        qaLoading.value = true;
        try {
            const response = await fetch(api.getQaStreamUrl(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-User-ID': getUserId() || '',
                },
                body: JSON.stringify({
                    question,
                    sessionId: qaSessionId.value,
                    contractId: contract.id,
                    history,
                }),
            });
            if (!response.ok || !response.body) throw new Error('STREAM_FAILED');
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';
                for (const eventText of events) {
                    const parsed = parseQaSseEvent(eventText);
                    if (!parsed) continue;
                    if (parsed.event === 'delta') {
                        // 通过响应式数组索引修改，触发 Vue 响应式更新
                        qaMessages.value[assistantIdx].content += parsed.data.content || '';
                        scrollQaToBottom();
                    }
                    if (parsed.event === 'done' && parsed.data.answer) {
                        qaMessages.value[assistantIdx].content = parsed.data.answer;
                    }
                    if (parsed.event === 'error') throw new Error(parsed.data.error || 'STREAM_FAILED');
                }
            }
            if (!qaMessages.value[assistantIdx].content.trim()) {
                qaMessages.value[assistantIdx].content = '未收到有效回答。';
            }
        } catch {
            ElMessage.error('问答请求失败，请稍后重试');
            qaMessages.value[assistantIdx].content = '抱歉，我现在无法回答您的问题。';
        } finally {
            qaLoading.value = false;
            scrollQaToBottom();
        }
    };
    const handleQaEnter = (event) => {
        if (!event.shiftKey) sendQaMessage();
    };
    const clearQaChat = () => {
        qaMessages.value = [];
        qaSessionId.value = uuidv4();
        localStorage.setItem('qa_session_id', qaSessionId.value);
        qaInput.value = '';
        qaLoading.value = false;
        ElMessage.success('已清空当前会话记录');
    };
    const selectedReviewPoints = ref([]);
    const customPurposes = ref([{ value: '' }]);

    const reviewData = reactive({
      dispute_points: [],
      missing_clauses: [],
      party_review: [],
      modification_suggestions: [],
      breach_cost_analysis: [],
      seal_analysis: [],
      relevant_laws: [],
    });

    const firstText = (...values) => values.find(value => typeof value === 'string' && value.trim()) || '';

    const joinLines = (...values) => values.filter(value => typeof value === 'string' && value.trim()).join('\n');

    const disputeTitle = (item, index) => firstText(item.title, item.type, item.original_clause, `风险点 ${index + 1}`);

    const disputeDescription = (item) => firstText(
      item.description,
      joinLines(
        item.original_clause && `原文：${item.original_clause}`,
        item.legal_reference && `法律依据：${item.legal_reference}`,
        item.dispute_rationale && `风险说明：${item.dispute_rationale}`,
      )
    );

    const missingClauseTitle = (item, index) => firstText(item.title, item.clause_type, `缺失条款 ${index + 1}`);

    const partyReviewTitle = (item, index) => firstText(item.title, item.review_point, `主体审查 ${index + 1}`);

    const partyReviewDescription = (item) => firstText(
      item.description,
      joinLines(
        item.party_A && `甲方：${item.party_A}`,
        item.party_B && `乙方：${item.party_B}`,
        item.status && `状态：${item.status}`,
        item.issue && `问题：${item.issue}`,
      )
    );

    const suggestionTitle = (item, index) => firstText(item.title, item.clause, `修改建议 ${index + 1}`);

    const suggestionOriginal = (item) => {
      // 优先使用 anchor_hint / highlight_segment（更可能在文档中找到）
      const hint = (item.anchor_hint || item.highlight_segment)?.trim();
      if (hint && hint.length >= 4) return hint;

      // 其次使用 original_text（但需要清理多余空白）
      const original = item.original_text?.replace(/\s+/g, ' ').trim();
      if (original && original.length >= 4) return original;

      // 尝试 original_clause
      const clause = item.original_clause?.replace(/\s+/g, ' ').trim();
      if (clause && clause.length >= 4) return clause;

      // 回退到 clause/title 的前50字符
      const title = firstText(item.clause, item.title);
      if (title) return title.substring(0, Math.min(50, title.length));

      return null;
    };

    const suggestionText = (item) => firstText(item.suggested_text, item.modification);

    const suggestionReason = (item) => firstText(item.reason, item.rationale);

    // WPS WebOffice 通过 SDK init 自动挂载，无需手动指定 URL
    const wpsEditorRef = ref(null);

    // === 风险评分仪表盘 ===
    const riskDashboardData = ref(null);
    const riskScoreLoading = ref(false);
    const loadRiskScore = async () => {
        if (!contract.id) return;
        riskScoreLoading.value = true;
        try {
            const res = await api.getRiskScore(contract.id);
            riskDashboardData.value = res.data;
        } catch (err) {
            console.warn('[RiskScore] Failed to load:', err.message);
        } finally {
            riskScoreLoading.value = false;
        }
    };

    // === 批注交互 (review_comments) ===
    const annotationMap = ref({}); // key: "item_type:index", value: { comments: [], summary: {} }
    const annotationLoading = ref(false);

    const getAnnotationKey = (itemType, itemIndex) => `${itemType}:${itemIndex}`;

    const getAnnotations = (itemType, itemIndex) => {
        const entry = annotationMap.value[getAnnotationKey(itemType, itemIndex)];
        return entry ? entry.comments : [];
    };

    const getAnnotationSummary = (itemType, itemIndex) => {
        const entry = annotationMap.value[getAnnotationKey(itemType, itemIndex)];
        return entry ? entry.summary : { agree: 0, disagree: 0, comment: 0, resolved: false };
    };

    const loadAnnotations = async () => {
        if (!contract.id) return;
        annotationLoading.value = true;
        try {
            const res = await api.getReviewComments(contract.id);
            const data = res.data;
            const map = {};
            Object.keys(data.summary || {}).forEach((key) => {
                map[key] = {
                    comments: data.grouped[key] || [],
                    summary: data.summary[key] || { agree: 0, disagree: 0, comment: 0, resolved: false },
                };
            });
            annotationMap.value = map;
        } catch (err) {
            console.warn('[Annotations] Failed to load:', err.message);
        } finally {
            annotationLoading.value = false;
        }
    };

    const handleAddAnnotation = async (payload) => {
        try {
            await api.addReviewComment(contract.id, payload);
            ElMessage.success(payload.action_type === 'comment' ? '批注已添加' : '已记录反馈');
            // 重置 commentingItemKey，防止批注面板重复打开
            commentingItemKey.value = null;
            await loadAnnotations();
        } catch (err) {
            ElMessage.error('反馈提交失败，请重试');
        }
    };

    const loadReviewTemplates = async () => {
      try {
        const response = await api.getReviewTemplates();
        reviewTemplates.value = response.data || [];
        if (!selectedTemplateId.value && reviewTemplates.value.length) {
          selectedTemplateId.value = reviewTemplates.value[0].id;
        }
      } catch (error) {
        console.error('Failed to load review templates:', error);
      }
    };

    const handleBeforeUpload = (file) => {
        const ext = file.name.split('.').pop().toLowerCase();
        const isValid = ['docx', 'doc', 'pdf'].includes(ext);
        if (!isValid) {
            ElMessage.error('只能上传 DOCX 或 PDF 格式的文件！');
            return false;
        }
        const maxSize = 50 * 1024 * 1024; // 50MB
        if (file.size > maxSize) {
            ElMessage.error('文件大小超过 50MB 限制，请压缩或拆分后上传。');
            return false;
        }
        loading.value = true;
        loadingMessage.value = '正在上传并为您准备编辑器...';
        return isValid;
    };

    const handleUploadSuccess = async (res) => {
        contract.id = res.contractId;
        contract.editorConfig = res.editorConfig;
        contract.original_filename = res.original_filename;
        setupSocket(contract.id);

        // 先进入确认步骤（Step 1），预分析在后台跑
        activeStep.value = 1;
        loading.value = true;
        preAnalyzing.value = true;

        // 后台异步启动预分析（非阻塞），完成后填充数据、显示确认界面
        api.preAnalyzeContract({ contractId: contract.id, templateId: selectedTemplateId.value }).then(preAnalysisRes => {
            Object.assign(preAnalysisData, preAnalysisRes.data);
            selectedTemplateId.value = preAnalysisData.template_id || selectedTemplateId.value || 'general';
            allSuggestedReviewPoints.value = [...preAnalysisData.suggested_review_points];
            allPotentialParties.value = [...preAnalysisData.potential_parties];
            allSuggestedCorePurposes.value = [...preAnalysisData.suggested_core_purposes];
            selectedReviewPoints.value = [...preAnalysisData.suggested_review_points];
            if (preAnalysisData.suggested_core_purposes && preAnalysisData.suggested_core_purposes.length > 0) {
              customPurposes.value = preAnalysisData.suggested_core_purposes.map(p => ({ value: p }));
            } else {
              customPurposes.value = [{ value: '示例：确保权利与义务对等' }];
            }
            preAnalyzing.value = false;
            loading.value = false;
            ElMessage.success('AI 初步分析完成，请确认审查范围后点击"开始分析"。');
        }).catch(err => {
            console.warn('预分析失败，用户仍可手动确认审查配置：', err);
            preAnalyzing.value = false;
            loading.value = false;
            // 即使失败也允许用户手动配置
            selectedTemplateId.value = 'general';
            selectedReviewPoints.value = [];
            customPurposes.value = [{ value: '' }];
            ElMessage.warning('预分析未成功，您仍可手动设置审查范围。');
        });
    };

    const handleUploadError = () => {
        loading.value = false;
        ElMessage.error('上传失败，请检查后端服务是否正常。');
    };

    const validateContractFile = (file) => {
        const ext = file.name.split('.').pop().toLowerCase();
        return ['docx', 'pdf'].includes(ext);
    };

    const openLinkedFilePicker = () => {
        linkedFileInput.value?.click();
    };

    const setLinkedProgress = (key, status, message) => {
        const labels = {
            select: '选择文件',
            group: '创建分析记录',
            upload: '上传关联合同',
            analyze: 'AI 关联分析',
            save: '保存分析结果',
        };
        const existing = linkedAnalysisProgress.value.find(item => item.key === key);
        const payload = { key, label: labels[key] || key, status, message };
        if (existing) {
            Object.assign(existing, payload);
        } else {
            linkedAnalysisProgress.value.push(payload);
        }
    };

    const handleLinkedFilesChange = (event) => {
        const files = Array.from(event.target.files || []);
        const validFiles = files.filter(validateContractFile);
        if (validFiles.length !== files.length) {
            ElMessage.warning('已忽略非 DOCX / PDF 格式文件。');
        }
        linkedGroupFiles.value = validFiles;
        linkedAnalysisResult.value = null;
        linkedAnalysisProgress.value = [];
        if (validFiles.length) {
            setLinkedProgress('select', validFiles.length >= 2 ? 'done' : 'running', `已选择 ${validFiles.length} 份合同。`);
        }
    };

    const uploadContractToGroup = async (file, groupId, userId) => {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('userId', userId);
        formData.append('groupId', groupId);
        return api.uploadContract(formData);
    };

    const startLinkedContractAnalysis = async () => {
        const userId = getUserId();
        if (!userId) {
            ElMessage.error('无法获取用户身份，请刷新页面重试。');
            return;
        }
        if (linkedGroupFiles.value.length < 2) {
            ElMessage.warning('请至少选择 2 份合同文件。');
            return;
        }

        linkedAnalysisLoading.value = true;
        linkedAnalysisResult.value = null;
        try {
            setLinkedProgress('group', 'running', '正在创建关联合同分析记录。');
            const groupName = `关联合同组 ${new Date().toLocaleString('zh-CN')}`;
            const groupRes = await api.createContractGroup({ name: groupName });
            const groupId = groupRes.data.id;
            setLinkedProgress('group', 'done', '分析记录已创建。');
            setLinkedProgress('upload', 'running', '正在上传所选合同。');
            await Promise.all(linkedGroupFiles.value.map((file) => uploadContractToGroup(file, groupId, userId)));
            setLinkedProgress('upload', 'done', '合同上传完成。');
            setLinkedProgress('analyze', 'running', 'AI 正在识别条款冲突与共同风险。');
            const analysisRes = await api.analyzeContractGroup(groupId);
            linkedAnalysisResult.value = analysisRes.data.result || {};
            setLinkedProgress('analyze', 'done', '关联分析完成。');
            setLinkedProgress('save', 'done', '分析结果已保存，可在历史记录中查看。');
            ElMessage.success('多合同关联分析已完成。');
        } catch (error) {
            setLinkedProgress('analyze', 'failed', error.response?.data?.error || '多合同关联分析失败。');
            ElMessage.error(error.response?.data?.error || '多合同关联分析失败，请稍后重试。');
        } finally {
            linkedAnalysisLoading.value = false;
        }
    };

    const uploadAndGo = async (file) => {
        const formData = new FormData();
        formData.append('file', file);
        const userId = getUserId();
        if (!userId) {
            ElMessage.error("无法获取用户身份，请刷新页面重试。");
            loading.value = false;
            return;
        }
        formData.append('userId', userId);

        try {
            const res = await api.uploadContract(formData);
            handleUploadSuccess(res.data);
        } catch (err) {
            handleUploadError();
        }
    };

    const goBackToUpload = () => {
        console.log('[DEBUG] goBackToUpload clicked.');
        resetState();
    };

    const goBackToConfirm = () => {
      activeStep.value = 1;
      isEditorReady.value = false;
    };

    const startStatusPolling = () => {
        if (statusPollTimer.value) return;
        statusPollTimer.value = setInterval(async () => {
            if (!contract.id) return;
            try {
                const res = await api.getAnalyzeStatus(contract.id);
                const data = res.data;
                if (typeof data.percent === 'number') analysisPercent.value = data.percent;
                if (Array.isArray(data.steps)) analysisSteps.value = data.steps;
                if (typeof data.elapsedSeconds === 'number') analysisElapsed.value = data.elapsedSeconds;
                if (data.status === 'completed' && data.result) {
                    Object.assign(reviewData, data.result);
                    analysisActive.value = false;
                    loading.value = false;
                    reAnalyzing.value = false;
                    activeStep.value = 2;
                    stopStatusPolling();
                    stopElapsedTimer();
                    ElMessage.success('审查完成。');
                    loadRiskScore();
                    loadAnnotations();
                } else if (data.status === 'failed') {
                    analysisActive.value = false;
                    loading.value = false;
                    reAnalyzing.value = false;
                    stopStatusPolling();
                    stopElapsedTimer();
                    ElMessage.error(data.error || '分析失败，请稍后重试');
                }
            } catch (err) {
                console.warn('[Status Poll] Failed to fetch analysis status:', err.message);
            }
        }, 3000);
    };

    const stopStatusPolling = () => {
        if (statusPollTimer.value) {
            clearInterval(statusPollTimer.value);
            statusPollTimer.value = null;
        }
    };

    const startAnalysis = async () => {
        if (!perspective.value) {
            ElMessage.warning('请输入您的审查立场。');
            return;
        }
        loading.value = true;
        analysisActive.value = true;
        analysisPercent.value = 0;
        analysisEta.value = 0;
        analysisElapsed.value = 0;
        analysisProgress.value = [];
        analysisSteps.value = [];
        loadingMessage.value = 'AI 正在深度审查合同，请通过下方进度追踪实时查看状态...';
        startElapsedTimer(); // 启动本地实时计时
        try {
            const analysisPayload = {
                contractId: contract.id,
                userPerspective: perspective.value,
                preAnalysisData: {
                    contract_type: preAnalysisData.contract_type,
                    potential_parties: allPotentialParties.value,
                    suggested_review_points: allSuggestedReviewPoints.value,
                    suggested_core_purposes: allSuggestedCorePurposes.value,
                    reviewPoints: selectedReviewPoints.value,
                    core_purposes: customPurposes.value.map(p => p.value).filter(p => p.trim() !== ''),
                    template_id: selectedTemplateId.value,
                },
            };
            // 异步启动：后端立即返回 jobId，实际结果通过 socket 推送
            const res = await api.analyzeContract(analysisPayload);
            analysisJobId.value = res.data.jobId;
            if (Array.isArray(res.data.steps)) {
                analysisSteps.value = res.data.steps.map((s) => ({ ...s, status: 'pending', message: '' }));
            }
            // 若 socket 未连接，启动轮询作为兜底
            if (!socket.value || !socket.value.connected) {
                startStatusPolling();
            }
        } catch(err) {
            const errorMessage = err.response?.data?.error || '启动分析失败，请稍后重试';
            ElMessage.error(errorMessage);
            analysisActive.value = false;
            loading.value = false;
        }
    };

    const addPurpose = () => {
      customPurposes.value.push({ value: '' });
    };

    const removePurpose = (index) => {
      customPurposes.value.splice(index, 1);
    };

    const forceSaveCurrentDocument = async (silent = true) => {
      if (!contract.id || forceSaveInFlight.value) return false;
      forceSaveInFlight.value = true;
      try {
        // WPS WebOffice v2 通过三阶段回调（prepare→address→complete）自动保存
        // 不主动调用 wpsInstance.save()，避免触发额外的"保存中"状态
        // 只调用后端 force-save API 确保数据库合同信息同步
        await api.forceSaveContract(contract.id, {
          documentKey: contract.editorConfig?.fileId,
        });
        hasPendingEditorChanges.value = false;
        if (!silent) ElMessage.success('已触发文档保存同步');
        return true;
      } catch (error) {
        console.warn('[WPS] force-save failed', error.response?.data || error.message);
        if (!silent) ElMessage.warning(error.response?.data?.error || '触发文档保存同步失败');
        return false;
      } finally {
        forceSaveInFlight.value = false;
      }
    };

    const scheduleForceSave = (delay = 1200) => {
      // WPS WebOffice v2 自带自动保存，不再通过前端调度额外保存
      // 保留此函数用于显式用户操作（返回、切换页面）时的保存
      if (!contract.id) return;
    };

    const stopAutoForceSave = () => {
      if (forceSaveTimer.value) {
        clearInterval(forceSaveTimer.value);
        forceSaveTimer.value = null;
      }
      if (forceSaveDebounceTimer.value) {
        clearTimeout(forceSaveDebounceTimer.value);
        forceSaveDebounceTimer.value = null;
      }
    };

    const startAutoForceSave = () => {
      // WPS WebOffice v2 自带三阶段保存机制（prepare→address→complete）
      // 前端不再主动触发保存，避免与 WPS 自身保存机制冲突导致"保存中"不消失
      // 仅保留 stopAutoForceSave 在组件销毁时清理定时器
      stopAutoForceSave();
    };

    // --- WPS WebOffice 编辑器初始化与销毁 ---

    const initWpsEditor = async () => {
      // WpsEditor 组件自动处理初始化，此函数仅作兼容
    };

    const onDocumentReady = () => {
      console.log("[INFO] WPS WebOffice document is ready.");
      setTimeout(async () => {
        isEditorReady.value = true;
        if (isEditorReady.value) startAutoForceSave();

        // Full-provider: 在文档开头创建书签（书签导航定位点）
        if (wpsEditorRef.value && typeof wpsEditorRef.value.ensureContractStartBookmark === 'function') {
          await wpsEditorRef.value.ensureContractStartBookmark();
        }

        // 如果是从历史记录加载的合同，且有未插入的批注，自动插入
        console.log('[DEBUG] onDocumentReady - needsAutoInsert:', needsAutoInsert.value, 'modification_suggestions:', reviewData.modification_suggestions?.length);
        if (needsAutoInsert.value && reviewData.modification_suggestions?.length > 0) {
          needsAutoInsert.value = false; // 重置标志
          console.log('[DEBUG] Calling autoInsertAnnotations...');
          // 延迟一下确保文档完全就绪
          await new Promise(r => setTimeout(r, 1000));
          // 先创建星法式风险书签（用于定位原文/原位批注/一键调整）
          if (wpsEditorRef.value && typeof wpsEditorRef.value.batchCreateRiskBookmarks === 'function') {
            console.log('[DEBUG] Calling batchCreateRiskBookmarks with', reviewData.modification_suggestions.length, 'items');
            await wpsEditorRef.value.batchCreateRiskBookmarks(reviewData.modification_suggestions);
            console.log('[DEBUG] batchCreateRiskBookmarks done');
          }
          await autoInsertAnnotations();
        }
      }, 300);
    };

    const destroyWpsEditor = async () => {
      isEditorReady.value = false;
    };

    const startReAnalysis = async () => {
      if (!perspective.value) {
        ElMessage.warning('请选择您的审查立场。');
        return;
      }
      reAnalyzing.value = true;
      loading.value = true;
      analysisActive.value = true;
      analysisPercent.value = 0;
      analysisEta.value = 0;
      analysisElapsed.value = 0;
      analysisProgress.value = [];
      analysisSteps.value = [];
      loadingMessage.value = '正在重新审查合同，请通过进度追踪查看状态...';
      startElapsedTimer(); // 启动本地实时计时
      try {
        const analysisPayload = {
          contractId: contract.id,
          userPerspective: perspective.value,
          preAnalysisData: {
                contract_type: preAnalysisData.contract_type,
                potential_parties: allPotentialParties.value,
                suggested_review_points: allSuggestedReviewPoints.value,
                suggested_core_purposes: allSuggestedCorePurposes.value,
                reviewPoints: selectedReviewPoints.value,
                core_purposes: customPurposes.value.map(p => p.value).filter(p => p.trim() !== ''),
                template_id: selectedTemplateId.value,
            },
        };
        const res = await api.analyzeContract(analysisPayload);
        analysisJobId.value = res.data.jobId;
        if (Array.isArray(res.data.steps)) {
            analysisSteps.value = res.data.steps.map((s) => ({ ...s, status: 'pending', message: '' }));
        }
        if (!socket.value || !socket.value.connected) {
            startStatusPolling();
        }
        // 结果通过 socket analysis-complete 事件或轮询更新，此处不等待
      } catch(err) {
        const errorMessage = err.response?.data?.error || '重审失败，请稍后重试';
        ElMessage.error(errorMessage);
        reAnalyzing.value = false;
        loading.value = false;
        analysisActive.value = false;
      }
    };

    const loadContractFromServer = async (contractId) => {
        loading.value = true;
        loadingMessage.value = '正在从历史记录加载合同...';
        try {
            // This endpoint needs to be created in the backend
            // It should return the full state needed for the review page
            const response = await api.getContractDetails(contractId);
            const contractData = response.data;

            // Populate all the relevant states from the fetched data
            activeStep.value = 2; // Directly go to the review step
            Object.assign(contract, contractData.contract);
            setupSocket(contract.id);
            perspective.value = contractData.perspective;
            Object.assign(preAnalysisData, contractData.preAnalysisData || {});
            selectedTemplateId.value = preAnalysisData.template_id || 'general';
            // The server now returns the complete list, so we can trust it.
            // Add defensive checks to prevent crashes if preAnalysisData or its keys are missing.
            allSuggestedReviewPoints.value = contractData.preAnalysisData?.suggested_review_points || [];
            allPotentialParties.value = contractData.preAnalysisData?.potential_parties || [];
            allSuggestedCorePurposes.value = contractData.preAnalysisData?.suggested_core_purposes || [];
            // The server also returns the specific selections for this historical review
            selectedReviewPoints.value = contractData.selectedReviewPoints || [];
            customPurposes.value = contractData.customPurposes || [{ value: '' }];
            Object.assign(reviewData, contractData.reviewData || {});

            // 标记需要自动插入批注（当文档加载完成后）
            console.log('[DEBUG] loadContractFromServer - reviewData.modification_suggestions:', reviewData.modification_suggestions?.length);
            if (reviewData.modification_suggestions?.length > 0) {
                needsAutoInsert.value = true;
                console.log('[DEBUG] needsAutoInsert set to TRUE');
            }

            // Save this loaded state to localStorage so a refresh works correctly
            saveState();

            // 加载该合同的专项审查历史
            loadFocusedReviewHistory();

            // 加载风险评分和批注
            loadRiskScore();
            loadAnnotations();

        } catch (error) {
            console.error(`Failed to load contract ${contractId} from server:`, error);
            ElMessage.error('加载历史记录失败，将返回首页。');
            router.push('/');
            resetState(); // Clear any partial state
        } finally {
            loading.value = false;
        }
    };

    // --- State Persistence Logic ---

    const saveState = () => {
        if (isResetting) return; // Prevent saving state during a programmatic reset

        const stateToSave = {
            activeStep: activeStep.value,
            contract: toRaw(contract),
            perspective: perspective.value,
            preAnalysisData: toRaw(preAnalysisData),
            selectedReviewPoints: selectedReviewPoints.value,
            customPurposes: customPurposes.value,
            reviewData: toRaw(reviewData),
            activeAiTab: activeAiTab.value,
            cameFromHistory: cameFromHistory.value,
            allSuggestedReviewPoints: allSuggestedReviewPoints.value,
            allPotentialParties: allPotentialParties.value,
            allSuggestedCorePurposes: allSuggestedCorePurposes.value,
            selectedTemplateId: selectedTemplateId.value,
        };
        // Only save if a contract has been uploaded to avoid storing empty sessions
        if (stateToSave.contract && stateToSave.contract.id) {
            localStorage.setItem('review_session', JSON.stringify(stateToSave));
        }
    };

    const querySearchCorePurposes = (queryString, cb) => {
        const results = queryString
            ? allSuggestedCorePurposes.value.filter(p => p.toLowerCase().includes(queryString.toLowerCase()))
            : allSuggestedCorePurposes.value;
        // The autocomplete component expects an array of objects with a `value` key.
        cb(results.map(p => ({ value: p })));
    };

    // Watch for any state changes and save them
    watch([activeStep, perspective, activeAiTab, selectedTemplateId], saveState);
    watch([
        contract,
        preAnalysisData,
        reviewData,
        selectedReviewPoints,
        customPurposes,
        allSuggestedReviewPoints,
        allPotentialParties,
        allSuggestedCorePurposes,
    ], saveState, { deep: true });

    // 当进入 Step 2 且有 editorConfig 时，初始化 WPS 编辑器
    watch(activeStep, async (newStep) => {
        if (newStep === 2 && contract.editorConfig) {
            await nextTick();
            await initWpsEditor();
        } else if (newStep !== 2) {
            await destroyWpsEditor();
        }
    });

    const restoreSessionFromSavedState = async (savedState) => {
        // Fetch fresh contract editorConfig from the server to get a new, valid token.
        const response = await api.getContractDetails(savedState.contract.id);
        const serverEditorConfig = response.data.contract.editorConfig;

        // Restore UI state from localStorage, as it's the source of truth for user's work.
        activeStep.value = savedState.activeStep;
        activeAiTab.value = savedState.activeAiTab || 'suggestions';
        if (!['summary', 'suggestions', 'knowledge', 'workspace'].includes(activeAiTab.value)) {
          activeAiTab.value = 'summary';
        }

        // Restore data objects from savedState
        Object.assign(contract, savedState.contract);
        // CRITICAL: Overwrite with the fresh editor config from the server.
        contract.editorConfig = serverEditorConfig;
        setupSocket(contract.id);

        perspective.value = savedState.perspective;
        Object.assign(preAnalysisData, savedState.preAnalysisData || {});
        selectedTemplateId.value = savedState.selectedTemplateId || preAnalysisData.template_id || 'general';
        Object.assign(reviewData, savedState.reviewData || {});

        // Restore lists from savedState
        selectedReviewPoints.value = savedState.selectedReviewPoints || [];
        customPurposes.value = savedState.customPurposes || [{ value: '' }];
        allSuggestedReviewPoints.value = savedState.allSuggestedReviewPoints || [];
        allPotentialParties.value = savedState.allPotentialParties || [];
        allSuggestedCorePurposes.value = savedState.allSuggestedCorePurposes || [];

        // 恢复会话后加载该合同的专项审查历史
        loadFocusedReviewHistory();
    };

    const loadState = async () => {
        const savedStateJSON = localStorage.getItem('review_session');
        if (savedStateJSON) {
            try {
                const savedState = JSON.parse(savedStateJSON);
                if (savedState.contract && savedState.contract.id) {
                    loading.value = true;
                    loadingMessage.value = '正在恢复您的会话...';
                    sessionLoadFailed.value = false;

                    try {
                        await restoreSessionFromSavedState(savedState);
                    } catch (error) {
                         console.error(`Failed to refresh session for contract ${savedState.contract.id}:`, error);
                         // 不再直接 resetState()，保留 localStorage 会话，提供重试入口
                         sessionLoadFailed.value = true;
                         ElMessage.error('恢复会话失败（可能是网络问题）。可点击"重试"重新加载，您的工作进度已保留。');
                    } finally {
                        loading.value = false;
                    }
                }
            } catch (e) {
                console.error("Failed to parse saved state, clearing invalid session.", e);
                localStorage.removeItem('review_session');
            }
        }
    };

    // 重试恢复会话（不丢失工作进度）
    const retryLoadSession = async () => {
        const savedStateJSON = localStorage.getItem('review_session');
        if (!savedStateJSON) {
            sessionLoadFailed.value = false;
            return;
        }
        loading.value = true;
        loadingMessage.value = '正在重试恢复会话...';
        try {
            const savedState = JSON.parse(savedStateJSON);
            await restoreSessionFromSavedState(savedState);
            sessionLoadFailed.value = false;
            ElMessage.success('会话恢复成功。');
        } catch (error) {
            ElMessage.error('重试失败，请检查网络后再次点击重试。');
        } finally {
            loading.value = false;
        }
    };

    const resetState = () => {
      console.log('[DEBUG] resetState called.');
      isResetting = true; // Lock the saving mechanism
      // 销毁 WPS 编辑器实例
      destroyWpsEditor();
      activeStep.value = 0;
      loading.value = false;
      loadingMessage.value = '';
      Object.assign(contract, initialContractState);
      perspective.value = '';
      Object.assign(reviewData, {
        dispute_points: [],
        missing_clauses: [],
        party_review: [],
        company_review: [],
        modification_suggestions: [],
        breach_cost_analysis: [],
        seal_analysis: [],
        relevant_laws: [],
      });
      isEditorReady.value = false;
      // Reset new states
      Object.assign(preAnalysisData, { contract_type: '', potential_parties: [], suggested_review_points: [], suggested_core_purposes: [], template_id: '', template_name: '' });
      selectedTemplateId.value = 'general';
      selectedReviewPoints.value = [];
      customPurposes.value = [{ value: '' }];
      allSuggestedReviewPoints.value = [];
      allPotentialParties.value = [];
      allSuggestedCorePurposes.value = [];
      selectedSuggestionPreview.value = null;
      focusedReviewText.value = '';
      focusedReviewQuestion.value = '';
      focusedReviewResult.value = null;
      focusedReviewLoading.value = false;
      // Clear the session from localStorage
      localStorage.removeItem('review_session');
      console.log('[DEBUG] review_session removed from localStorage.');

      // Use nextTick to ensure the DOM has updated and state changes have propagated
      // before we unlock the saving mechanism.
      nextTick(() => {
        isResetting = false;
        console.log('[DEBUG] resetState finished and lock released.');
      });
    };

    // This is the correct guard for handling navigation that reuses the same component instance.
    onBeforeRouteUpdate((to, from) => {
      console.log(`[DEBUG] onBeforeRouteUpdate: from ${from.fullPath} to ${to.fullPath}`);
      // When navigating from a history-loaded review page (which has a contract_id)
      // back to the main 'start' page (which does not), we must reset the entire state
      // to ensure a completely fresh start.
      if (from.query.contract_id && !to.query.contract_id) {
          console.log('[DEBUG] Route condition met. Calling resetState.');
          resetState();
      }
    });

    // Load state from localStorage or from server if contract_id is in query/params
    onMounted(() => {
      loadReviewTemplates();
      // 支持两种方式获取合同ID：route.params.id 或 route.query.contract_id
      const contractIdFromParams = route.params.id;
      const contractIdFromQuery = route.query.contract_id;
      const contractId = contractIdFromParams || contractIdFromQuery;
      
      if (contractId) {
        // 如果URL中有合同ID，加载已有合同（查看模式）
        resetState();
        cameFromHistory.value = true; // Mark that we are in history-viewing mode
        loadContractFromServer(contractId);
      } else {
        // 否则从localStorage恢复或显示上传界面
        cameFromHistory.value = false;
        loadState();
      }
    });

    const goBackSmart = () => {
        if (cameFromHistory.value) {
            forceSaveCurrentDocument(true);
            router.push('/history');
        } else {
            forceSaveCurrentDocument(true);
            goBackToConfirm(); // Keep the original behavior for normal flow
        }
    };

    // 在当前页面打开智能问答浮窗，不再跳转页面
    const goToQnA = () => {
        forceSaveCurrentDocument(true);
        qaPanelOpen.value = true;
        scrollQaToBottom();
    };

    onUnmounted(() => {
        stopAutoForceSave();
        forceSaveCurrentDocument(true);
        destroyWpsEditor();
        stopStatusPolling();
        stopElapsedTimer();
        if (socket.value) socket.value.disconnect();
    });

    // --- WPS WebOffice 自定义按钮回调 ---
    const handleWpsButtonAction = (payload) => {
      console.log('[WPS Button] Action:', payload.action);
      switch (payload.action) {
        case 'back':
          goBackSmart();
          break;
        case 'export-annotated':
          exportAnnotatedDocx();
          break;
        case 'show-review':
          activeAiTab.value = 'summary';
          break;
        case 'back-to-list':
          forceSaveCurrentDocument(true);
          router.push('/');
          break;
        default:
          console.log('[WPS Button] Unknown action:', payload.action);
      }
    };

    // --- WPS WebOffice Connector Methods ---

    const getWpsApplication = async () => {
      if (!wpsEditorRef.value || typeof wpsEditorRef.value.getApplication !== 'function') return null;
      return wpsEditorRef.value.getApplication();
    };

    const getEditor = () => wpsEditorRef.value || null;

    const executeEditorMethod = async (method, args = []) => {
      try {
        const app = await getWpsApplication();
        if (!app) throw new Error('Application not ready');
        
        // Build a JavaScript expression to evaluate against the WPS Application object
        // WPS WebOffice JSAPI uses COM-like property/method chains
        // e.g., app.ActiveDocument.Selection.Find.Execute({Text: 'xxx'})
        // We build the expression path dynamically
        const parts = method.split('.');
        let current = app;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (i === parts.length - 1) {
            // Last part: invoke with args
            if (typeof current[part] === 'function') {
              return await current[part](...args);
            }
            return current[part];
          }
          current = current[part];
          if (!current) throw new Error(`Cannot resolve ${parts.slice(0, i+1).join('.')}`);
        }
        return current;
      } catch (error) {
        console.warn('[WPS Connector] executeEditorMethod failed:', method, error.message);
        throw error;
      }
    };

    const findTextRange = async (text) => {
      if (!text || text.length < 2) return null;
      console.log('[DEBUG] findTextRange searching:', text.substring(0, 50));
      try {
        const app = await getWpsApplication();
        if (!app) {
          console.log('[DEBUG] findTextRange: no app');
          return null;
        }

        const doc = app.ActiveDocument;
        if (!doc) {
          console.log('[DEBUG] findTextRange: no ActiveDocument');
          return null;
        }

        // 尝试多种Find方式
        let find = null;
        let searchRange = null;

        // 方式1: Selection.Find (桌面Word方式)
        const selection = doc.Selection;
        console.log('[DEBUG] Selection:', !!selection, 'Find:', !!selection?.Find);
        if (selection?.Find) {
          find = selection.Find;
          searchRange = selection;
          console.log('[DEBUG] 使用 Selection.Find');
        }

        // 方式2: Content.Find (有些版本支持)
        if (!find && doc.Content?.Find) {
          find = doc.Content.Find;
          searchRange = doc.Content;
          console.log('[DEBUG] 使用 Content.Find');
        }

        // 方式3: 尝试 GoTo + Find 组合
        if (!find) {
          try {
            if (doc.Content?.Select) {
              await doc.Content.Select();
              const newSelection = doc.Selection;
              if (newSelection?.Find) {
                find = newSelection.Find;
                searchRange = newSelection;
                console.log('[DEBUG] 使用 Content.Select + Selection.Find');
              }
            }
          } catch (e) {
            console.warn('[WPS] Content.Select尝试失败:', e.message);
          }
        }

        if (!find) {
          console.warn('[WPS] 未找到可用的Find接口，尝试使用Range遍历');
          // Fallback: 使用 Range 遍历文档
          try {
            // 获取文档内容范围
            if (doc.Content?.Start !== undefined && doc.Content?.End !== undefined) {
              const start = doc.Content.Start;
              const end = doc.Content.End;
              console.log('[DEBUG] 文档范围:', start, '-', end);
              
              // 创建整个文档范围的Range
              const fullRange = doc.Range(start, end);
              if (fullRange) {
                const fullText = fullRange.Text || '';
                if (fullText.includes(text)) {
                  console.log('[DEBUG] Range遍历找到文本在文档中');
                  // 选中整个文档以便后续操作
                  fullRange.Select();
                  return fullRange;
                } else {
                  console.log('[DEBUG] 文本不在文档中，当前查找:', text.substring(0, 30));
                  console.log('[DEBUG] 文档内容片段:', fullText.substring(0, 200));
                }
              }
            }
          } catch (e) {
            console.warn('[WPS] Range遍历失败:', e.message);
          }
          return null;
        }

        console.log('[DEBUG] 执行 Find.Execute');
        // Execute find - this searches for the text and selects it if found
        // WPS WebOffice 可能需要不同的参数格式
        let found = false;
        try {
          found = await find.Execute({ Text: text });
        } catch (e1) {
          console.warn('[DEBUG] Execute({Text}) 失败:', e1.message);
          try {
            found = await find.Execute({ FindText: text });
          } catch (e2) {
            console.warn('[DEBUG] Execute({FindText}) 失败:', e2.message);
            try {
              found = await find.Execute(text);
            } catch (e3) {
              console.warn('[DEBUG] Execute(text) 失败:', e3.message);
            }
          }
        }
        console.log('[DEBUG] Find.Execute result:', found);
        if (found) {
          // Text was found and selected - return the Range object
          return searchRange?.Range || selection?.Range;
        }

        // Try with normalized text
        const normalized = text.replace(/[""]/g, '"').replace(/['']/g, "'").replace(/\s+/g, '');
        if (normalized !== text && normalized.length >= 4) {
          console.log('[DEBUG] 尝试 normalized:', normalized.substring(0, 50));
          // Try fuzzy find by searching just the first 30 chars
          const shortText = text.slice(0, Math.min(30, text.length));
          const foundShort = await find.Execute({ Text: shortText });
          if (foundShort) {
            console.log('[DEBUG] shortText found');
            return selection.Range;
          }

          // Try first sentence
          const firstSentence = text.split(/[。；;.!?]/)[0];
          if (firstSentence && firstSentence.length >= 4) {
            const foundSentence = await find.Execute({ Text: firstSentence.trim() });
            if (foundSentence) {
              console.log('[DEBUG] firstSentence found');
              return selection.Range;
            }
          }
        }
        return null;
      } catch (error) {
        console.warn('[WPS Connector] findTextRange failed:', error.message);
        return null;
      }
    };
    const normalizeCandidate = (text) => String(text || '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, '')
        .trim();

    const splitCandidateSentences = (text) => String(text || '')
        .split(/(?<=[。！？；;.!?])|\n+/g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 6);

    const buildSuggestionCandidates = (originalText, item = {}) => {
        const candidates = [
            originalText,
            item.anchor_hint,
            item.original_clause,
            item.clause,
            ...splitCandidateSentences(originalText),
        ];
        const compact = normalizeCandidate(originalText);
        if (compact && compact !== originalText) candidates.push(compact);
        if (originalText && originalText.length > 80) {
            candidates.push(originalText.slice(0, 80));
            candidates.push(originalText.slice(-80));
        }
        const seen = new Set();
        return candidates
            .map((candidate) => String(candidate || '').trim())
            .filter((candidate) => candidate.length >= 4)
            .filter((candidate) => {
                const key = normalizeCandidate(candidate);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    };

    const findTextRangeByCandidates = async (candidates) => {
        for (const candidate of candidates) {
            const range = await findTextRange(candidate);
            if (range) return { range, matchedText: candidate };
        }
        return null;
    };

    const ensureEditorReady = () => {
        if (!getEditor()) {
            ElMessage.warning('编辑器尚未就绪，请等待左侧文档加载完成。');
            return false;
        }
        return true;
    };

    const previewSuggestion = (item, status = '待采纳') => {
        selectedSuggestionPreview.value = {
            before: suggestionOriginal(item) || 'AI 未返回可直接定位的原文。',
            after: suggestionText(item) || 'AI 未返回建议替换文本。',
            status,
        };
    };

    const locateText = async (text, itemType = 'suggestion', itemIndex = -1) => {
        if (!text) {
            ElMessage.info('AI 未返回可定位的原文，请在文档中手动核对该建议。');
            return;
        }
        try {
            const app = await getWpsApplication();
            if (!app) {
                for (let i = 0; i < 5; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const retry = await getWpsApplication();
                    if (retry) { return await doLocateText(text, itemType, itemIndex, retry); }
                }
                ElMessage.info('WPS 文档尚未完全加载，请稍候再试。');
                return;
            }
            await doLocateText(text, itemType, itemIndex, app);
        } catch (error) {
            console.warn('[locateText] error:', error);
            ElMessage.info('文档定位暂时不可用，请手动在左侧文档中查找。');
        }
    };

    // ========== 风险总览（dispute_points）书签定位 ==========
    // 书签存在时直接导航；不存在时按需创建书签（存量合同场景）
    const gotoDisputeBookmark = async (item, index) => {
        const app = await getWpsApplication();
        if (!app) { ElMessage.info('WPS 文档尚未加载，请稍候'); return; }
        if (item.titleBookmark) {
            try {
                const ok = await wpsEditorRef.value?.gotoBookmark(item.titleBookmark);
                if (!ok) throw new Error('gotoBookmark returned false');
            } catch (e) {
                console.warn('[gotoDisputeBookmark] bookmark failed, recreate:', e);
                ElMessage.info('书签已失效，正在重新定位...');
                await createAndGotoDisputeBookmark(item, index, app);
            }
        } else {
            await createAndGotoDisputeBookmark(item, index, app);
        }
    };

    // 按需为 dispute_point 创建书签并导航
    const createAndGotoDisputeBookmark = async (item, index, app) => {
        // 优先用 original_clause（原文片段），其次用 title 摘要
        const searchText = item.original_clause || item.title;
        if (!searchText) { ElMessage.info('无法定位：缺少原文文本'); return; }
        // 复用 batchCreateRiskBookmarks 逻辑（传单项数组）
        const wps = wpsEditorRef.value;
        if (!wps) { await locateText(searchText, 'dispute_point', index); return; }
        try {
            const itemId = `dp_${contract.id}_${index}_${Date.now()}`;
            // batchCreateRiskBookmarks 依赖 item.filtered_content，找不到则用 original_clause 兜底
            const tempItem = { ...item, id: itemId, original_text: searchText, filtered_content: item.filtered_content || searchText };
            await wps.batchCreateRiskBookmarks([tempItem], app);
            if (!tempItem.titleBookmark) throw new Error('bookmark not created');
            item.titleBookmark = tempItem.titleBookmark;
            item.editBookmark = tempItem.editBookmark;
            const ok = await wps.gotoBookmark(tempItem.titleBookmark);
            if (!ok) throw new Error('gotoBookmark returned false');
        } catch (e) {
            console.warn('[createAndGotoDisputeBookmark] failed, fallback to text:', e);
            await locateText(searchText, 'dispute_point', index);
        }
    };

    const addReviewCommentByDisputeBookmark = async (item, index) => {
        const app = await getWpsApplication();
        if (!app) { ElMessage.info('WPS 文档尚未加载'); return; }
        if (!item.editBookmark) {
            // 按需创建 editBookmark
            await createDisputeEditBookmark(item, index, app);
        }
        if (item.editBookmark) {
            await wpsEditorRef.value?.addReviewCommentByBookmarkWps(
                item.editBookmark,
                { action: item.action || 'warn', target_text: item.original_clause, actionText: '风险说明', new_text: item.risk_suggestion || '' },
                item.id || index
            );
        } else {
            ElMessage.info('书签创建失败，请稍候再试');
        }
    };

    const adjustReplaceByDisputeBookmark = async (item, index) => {
        const app = await getWpsApplication();
        if (!app) { ElMessage.info('WPS 文档尚未加载'); return; }
        if (!item.editBookmark) {
            await createDisputeEditBookmark(item, index, app);
        }
        if (item.editBookmark) {
            await wpsEditorRef.value?.adjustReplaceByBookmarkWps(
                item.editBookmark,
                { action: 'warn', target_text: item.original_clause, new_text: item.risk_suggestion || '' },
                item.id || index
            );
        } else {
            ElMessage.info('书签创建失败，请稍候再试');
        }
    };

    // 为 dispute_point 按需创建 editBookmark
    const createDisputeEditBookmark = async (item, index, app) => {
        const searchText = item.original_clause || item.title;
        if (!searchText) return;
        const wps = wpsEditorRef.value;
        if (!wps) return;
        try {
            const itemId = `dp_${contract.id}_${index}_${Date.now()}`;
            const tempItem = { ...item, id: itemId, original_text: searchText, filtered_content: searchText };
            await wps.batchCreateRiskBookmarks([tempItem], app);
            item.titleBookmark = tempItem.titleBookmark;
            item.editBookmark = tempItem.editBookmark;
        } catch (e) {
            console.warn('[createDisputeEditBookmark] failed:', e);
        }
    };

    // =============================================
    // 原文定位：doLocateText（完整重写）
    // WebOffice Find.Execute 返回 [{ found, pos, len }] 而非 boolean
    // 方案1: 书签定位 → 方案2: anchor_hint 搜索 → 方案3: contract_start → 方案4: 提示手动
    // =============================================
    const doLocateText = async (text, itemType, itemIndex, app) => {
        // 局部 normalizeText（与 WpsEditor.vue 保持一致，全角→半角）
        const norm = (t) => String(t || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/[""]/g, '"').replace(/['']/g, "'")
            .replace(/[：]/g, ':').replace(/[，]/g, ',')
            .replace(/[。]/g, '.').replace(/[、]/g, ',')
            .replace(/[；]/g, ';').replace(/[！]/g, '!').replace(/[？]/g, '?')
            .replace(/\s+/g, ' ').trim();

        const doc = app?.ActiveDocument;
        if (!doc) { console.warn('[doLocateText] no doc'); return; }

        const normText = norm(text);
        if (!normText) { ElMessage.info('无原文文本，无法定位'); return; }

        // ── 方案1: 书签直接定位（如果有对应书签）─────────────
        if (itemType === 'suggestion' && itemIndex >= 0 && doc?.Bookmarks) {
            const bmName = `suggestion_${itemIndex}`;
            try {
                const bm = await doc.Bookmarks.Item(bmName);
                const bmRange = await bm?.Range;
                if (bmRange) {
                    await bmRange.Select();
                    doc.ActiveWindow?.ScrollIntoView?.(bmRange);
                    ElMessage.success(`已定位到建议 ${itemIndex + 1} 对应原文位置`);
                    return;
                }
            } catch (e) {
                console.warn(`[doLocateText] bookmark ${bmName} not found:`, e.message);
            }
        }

        // ── 方案2: anchor_hint / 原文字段搜索定位 ────────────
        let anchorHint = normText;
        if (itemType === 'suggestion' && itemIndex >= 0) {
            const suggestion = reviewData.modification_suggestions?.[itemIndex];
            if (suggestion?.anchor_hint) {
                anchorHint = norm(suggestion.anchor_hint);
            }
        }
        const searchText = anchorHint.length >= 2 ? anchorHint : normText;

        try {
            if (doc?.Range && doc?.Content) {
                // 获取文档实际末尾位置
                const docEnd = doc.Content?.End ?? doc.Content?.Range?.End ?? 999999;
                const searchRange = doc.Range(0, docEnd);
                const findObj = searchRange.Find;

                findObj.Text = searchText;
                findObj.Forward = true;
                findObj.Wrap = 0; // wdFindStop=0

                let loop = 0;
                while (loop < 100) {
                    loop++;
                    // Execute() 在 WebOffice 返回 [{ found: bool, pos: int, len: int }]
                    const result = await findObj.Execute();

                    // 标准化返回值
                    let found = false, pos = -1, len = 0;
                    if (Array.isArray(result) && result.length > 0) {
                        found = !!result[0].found;
                        pos = Number(result[0].pos) || -1;
                        len = Number(result[0].len) || 0;
                    } else if (typeof result === 'boolean') {
                        found = result;
                    }

                    if (!found || pos < 0) break;

                    // 找到了！选中文本并滚动
                    try {
                        const foundRange = doc.Range(pos, pos + len);
                        await foundRange.Select();
                        doc.ActiveWindow?.ScrollIntoView?.(foundRange);
                    } catch {
                        // 选区失败也继续
                    }

                    ElMessage.success(`已定位："${searchText.substring(0, 12)}..."`);
                    return;
                }
            }
        } catch (e) {
            console.warn('[doLocateText] Range.Find failed:', e.message);
        }

        // ── 方案3: 跳转到 contract_start 书签 ────────────────
        try {
            if (doc?.Bookmarks) {
                const startBm = await doc.Bookmarks.Item('contract_start');
                const startRange = await startBm?.Range;
                if (startRange) {
                    await startRange.Select();
                    doc.ActiveWindow?.ScrollIntoView?.(startRange);
                    ElMessage.warning(
                        `无法定位到原文，已跳转到文档开头。\n请手动查找："${searchText.substring(0, 15)}..."`,
                        { duration: 5000 }
                    );
                    return;
                }
            }
        } catch (e) {
            console.warn('[doLocateText] contract_start fallback failed:', e.message);
        }

        // ── 方案4: 完全无法定位 ──────────────────────────────
        ElMessage.warning(
            `无法定位 "${searchText.substring(0, 15)}..."，请在左侧文档中手动查找。`,
            { duration: 4000 }
        );
    };

    const replaceTextOnServer = async (originalText, suggestedText, item = {}) => {
        const response = await api.replaceContractText(contract.id, {
            originalText,
            suggestedText,
            originalCandidates: buildSuggestionCandidates(originalText, item),
        });
        return response.data.replacements || 0;
    };

    const markAdoptedText = async (originalText, suggestedText) => {
        try {
            const replacement = await findTextRangeByCandidates([suggestedText, suggestedText.slice(0, 80), suggestedText.slice(-80)]);
            if (!replacement?.range) return;
            await executeEditorMethod('SelectRange', [replacement.range]);
            const highlightMethods = [
                ['SetHighlightColor', ['#FFF2A8']],
                ['SetTextHighlightColor', ['#FFF2A8']],
                ['SetHighlight', ['#FFF2A8']],
            ];
            for (const [method, args] of highlightMethods) {
                try {
                    await executeEditorMethod(method, args);
                    break;
                } catch {
                    // Try the next OnlyOffice build-specific method name.
                }
            }
            await executeEditorMethod('AddComment', [`采纳前原文：${originalText}`, 'AI 审查']).catch(() => null);
        } catch {
            // 高亮/批注功能取决于 WPS 版本
        }
    };

    const replaceTextInEditor = async (originalText, suggestedText, onSuccess, onFailure, item = {}) => {
        const runServerFallback = async (statusPrefix = 'OnlyOffice 未开放当前编辑方法，已更新源文件') => {
            try {
                const replacements = await replaceTextOnServer(originalText, suggestedText, item);
                onSuccess?.({ fallback: true, replacements });
                ElMessage.success(`${statusPrefix}；当前编辑器不刷新，重新打开该合同后可见。`);
            } catch (serverError) {
                const message = serverError.response?.data?.error || '服务器替换失败，请缩短原文片段后重试。';
                ElMessage.error(message);
                onFailure?.(message);
            }
        };

        if (!ensureEditorReady()) {
            onFailure?.('编辑器尚未就绪，请稍候');
            return;
        }
        try {
            const matched = await findTextRangeByCandidates(buildSuggestionCandidates(originalText, item));
            if (!matched?.range) {
                await runServerFallback('编辑器未匹配到原文，已尝试从 DOCX 源文件替换');
                return;
            }
            await executeEditorMethod('SelectRange', [matched.range]);
            try {
                await executeEditorMethod('PasteText', [suggestedText]);
            } catch {
                await executeEditorMethod('ReplaceText', [matched.range, suggestedText]);
            }
            await markAdoptedText(originalText, suggestedText);
            onSuccess?.();
        } catch (error) {
            await runServerFallback();
        }
    };

    const refreshEditorDocument = async () => {
        // WPS WebOffice：更新配置后重新 init 来刷新文档
        try {
            // WPS: 重新加载文件
            const res = await api.getFreshEditorConfig(contract.id);
            const editorConfig = res.data?.editorConfig;
            if (editorConfig) {
                contract.editorConfig = editorConfig;
                // WPS SDK destroy + 重新 init 由 WpsEditor 组件通过 watch config 自动处理
                return true;
            }
        } catch {}
        return false;
    };

    const serverFallback = async (originalText, suggestedText, onSuccess, onFailure, item = {}) => {
        try {
            const replacements = await replaceTextOnServer(originalText, suggestedText, item);
            const refreshed = await refreshEditorDocument();
            if (refreshed) {
                onSuccess?.({ fallback: true, refreshed: true, replacements });
                ElMessage.success('已更新源文件并尝试自动刷新编辑器');
            } else {
                onSuccess?.({ fallback: true, replacements });
                ElMessage.success('已更新源文件，刷新页面后可查看变更');
            }
        } catch (err) {
            const msg = err.response?.data?.error || '替换失败';
            ElMessage.error(msg);
            onFailure?.(msg);
        }
    };

    const replaceTextInEditorFinal = async (originalText, suggestedText, onSuccess, onFailure, item = {}) => {
        if (!ensureEditorReady()) {
            await serverFallback(originalText, suggestedText, onSuccess, onFailure, item);
            return;
        }

        let success = false;
        const editor = getEditor();

        try {
            const canUseLiveApi = typeof editor.executeMethod === 'function'
                || typeof editor.createConnector === 'function'
                || Boolean(window.Asc?.plugin?.callCommand);
            if (!canUseLiveApi) {
                await serverFallback(originalText, suggestedText, onSuccess, onFailure, item);
                return;
            }

            const matched = await findTextRangeByCandidates(buildSuggestionCandidates(originalText, item));
            if (matched?.range) {
                await executeEditorMethod('SelectRange', [matched.range]);
            }

            if (matched?.range && typeof editor.createConnector === 'function') {
                const connector = editor.createConnector();
                if (connector?.callCommand) {
                    const asc = window.Asc || (window.Asc = {});
                    asc.scope = asc.scope || {};
                    asc.scope.suggestedText = suggestedText;
                    await new Promise((resolve) => {
                        connector.callCommand(function() {
                            try {
                                const oDocument = Api.GetDocument();
                                const oRange = oDocument.GetRangeBySelect?.() || null;
                                if (oRange) oRange.Delete();
                                const oParagraph = Api.CreateParagraph();
                                oParagraph.AddText(Asc.scope.suggestedText);
                                oDocument.InsertContent([oParagraph], false, { KeepTextOnly: false });
                            } catch (e) {}
                        }, true);
                        setTimeout(resolve, 800);
                    });
                    success = true;
                }
            }

            if (!success && matched?.range && window.Asc?.plugin?.callCommand) {
                window.Asc.scope = window.Asc.scope || {};
                window.Asc.scope.suggestedText = suggestedText;
                await new Promise((resolve) => {
                    window.Asc.plugin.callCommand(function() {
                        try {
                            const oDocument = Api.GetDocument();
                            const oRange = oDocument.GetRangeBySelect?.() || null;
                            if (oRange) oRange.Delete();
                            const oParagraph = Api.CreateParagraph();
                            oParagraph.AddText(Asc.scope.suggestedText);
                            oDocument.InsertContent([oParagraph], false, { KeepTextOnly: false });
                        } catch (e) {}
                    }, true);
                    setTimeout(resolve, 800);
                });
                success = true;
            }

            if (!success && matched?.range) {
                await executeEditorMethod('SelectRange', [matched.range]);
                try {
                    await executeEditorMethod('PasteText', [suggestedText]);
                    success = true;
                } catch {}
                if (!success) {
                    try {
                        await executeEditorMethod('ReplaceText', [matched.range, suggestedText]);
                        success = true;
                    } catch {}
                }
            }

            if (success) {
                await markAdoptedText(originalText, suggestedText);
                // 触发保存
                scheduleForceSave();
                onSuccess?.({ realTime: true });
                ElMessage.success('建议已实时采纳并更新到文档');
                return;
            }
        } catch (error) {
            console.warn('实时替换失败，进入服务器兜底', error);
        }

        await serverFallback(originalText, suggestedText, onSuccess, onFailure, item);
    };

    const prepareFocusedReviewFromSelection = async () => {
        activeAiTab.value = 'workspace';
        // WPS JSAPI GetSelectedText 待集成，提示用户手动粘贴
        ElMessage.info('请从左侧 WPS 文档中复制需要审查的文本，粘贴到下方输入框后进行专项审查。');
    };

    const submitFocusedReview = async () => {
        if (!focusedReviewText.value.trim()) return;
        focusedReviewLoading.value = true;
        try {
            const response = await api.reviewSelectedText({
                text: focusedReviewText.value,
                question: focusedReviewQuestion.value,
                perspective: perspective.value,
                contractType: preAnalysisData.contract_type,
                templateId: selectedTemplateId.value,
                contractId: contract.id,
            });
            focusedReviewResult.value = response.data;
            // 重新加载历史列表以包含新保存的记录
            if (contract.id) loadFocusedReviewHistory();
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '专项审查失败，请稍后重试。');
        } finally {
            focusedReviewLoading.value = false;
        }
    };

    const loadFocusedReviewHistory = async () => {
        if (!contract.id) return;
        focusedReviewHistoryLoading.value = true;
        try {
            const response = await api.getFocusedReviews(contract.id);
            focusedReviewHistory.value = response.data.items || [];
        } catch (error) {
            // 静默失败，不影响主流程
            console.warn('Failed to load focused review history:', error);
        } finally {
            focusedReviewHistoryLoading.value = false;
        }
    };

    const loadFocusedReviewFromHistory = (item) => {
        focusedReviewText.value = item.source_text || '';
        focusedReviewQuestion.value = item.question || '';
        focusedReviewResult.value = item.result || null;
        ElMessage.success('已加载历史专项审查记录。');
    };

    const deleteFocusedReviewFromHistory = async (reviewId) => {
        try {
            await api.deleteFocusedReview(reviewId);
            focusedReviewHistory.value = focusedReviewHistory.value.filter((i) => i.id !== reviewId);
            ElMessage.success('已删除该条历史记录。');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '删除失败，请稍后重试。');
        }
    };

    const formatHistoryTime = (timeStr) => {
        if (!timeStr) return '';
        try {
            const d = new Date(timeStr);
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } catch {
            return timeStr;
        }
    };

    const applyFocusedSuggestion = () => {
        if (!focusedReviewResult.value?.suggested_text) return;
        replaceTextInEditorFinal(focusedReviewText.value, focusedReviewResult.value.suggested_text, () => {
            selectedSuggestionPreview.value = {
                before: focusedReviewText.value,
                after: focusedReviewResult.value.suggested_text,
                status: '专项审查建议已替换到左侧文档',
            };
            focusedReviewText.value = focusedReviewResult.value.suggested_text;
            ElMessage.success('专项审查建议已更新到左侧文档。');
        }, (status) => {
            selectedSuggestionPreview.value = {
                before: focusedReviewText.value,
                after: focusedReviewResult.value.suggested_text,
                status,
            };
        });
    };

    // 高亮指定范围（用于风险条款标注）
    // highlightType: 'risk' = 红色, 'warning' = 橙色, 'info' = 蓝色
    const highlightCurrentRange = async (highlightType = 'risk') => {
        try {
            const app = await getWpsApplication();
            if (!app?.ActiveDocument?.Selection) return false;
            const range = app.ActiveDocument.Selection.Range;
            if (!range) return false;
            
            // 设置高亮颜色
            const colorMap = {
                risk: 0xFF6666,     // 红色高亮
                warning: 0xFFAA00,  // 橙色高亮  
                info: 0x66B3FF,     // 蓝色高亮
                success: 0x66FF66   // 绿色高亮
            };
            const color = colorMap[highlightType] || colorMap.risk;
            
            // WPS JSAPI: 设置文字高亮颜色
            if (typeof range.Highlight === 'number') {
                range.Highlight = color;
            }
            return true;
        } catch (error) {
            console.warn('[WPS Connector] highlightCurrentRange failed:', error.message);
            return false;
        }
    };

    // 书签管理：添加书签
    const addBookmark = async (bookmarkName, range) => {
        try {
            const app = await getWpsApplication();
            if (!app?.ActiveDocument?.Bookmarks) return false;
            const doc = app.ActiveDocument;
            
            // 删除已存在的同名书签
            try {
                const existing = doc.Bookmarks.Item(bookmarkName);
                if (existing) await existing.Delete();
            } catch {}
            
            // 添加新书签
            if (typeof doc.Bookmarks.Add === 'function') {
                await doc.Bookmarks.Add(bookmarkName, range);
                console.log(`[Bookmark] Added: ${bookmarkName}`);
                return true;
            }
            return false;
        } catch (error) {
            console.warn('[WPS Connector] addBookmark failed:', error.message);
            return false;
        }
    };

    // 书签管理：通过书签名称跳转
    const jumpToBookmark = async (bookmarkName) => {
        try {
            const app = await getWpsApplication();
            if (!app?.ActiveDocument?.Bookmarks) {
                ElMessage.info('书签功能不可用');
                return false;
            }
            const doc = app.ActiveDocument;
            
            // 查找书签
            let bookmark = null;
            try {
                bookmark = doc.Bookmarks.Item(bookmarkName);
            } catch {
                console.warn(`[Bookmark] Not found: ${bookmarkName}`);
                return false;
            }
            
            if (bookmark && bookmark.Range) {
                // 选中书签所在范围并滚动视图
                const range = bookmark.Range;
                if (typeof range.Select === 'function') {
                    await range.Select();
                }
                if (typeof range.ScrollIntoView === 'function') {
                    await range.ScrollIntoView();
                }
                // 高亮显示
                await highlightCurrentRange('warning');
                ElMessage.success(`已跳转到书签：${bookmarkName}`);
                return true;
            }
            return false;
        } catch (error) {
            console.warn('[WPS Connector] jumpToBookmark failed:', error.message);
            return false;
        }
    };

    // ========== Full-provider: Version History ==========
    const toggleVersionHistory = async () => {
        showVersionHistory.value = !showVersionHistory.value;
        showWatermarkMenu.value = false;
        if (showVersionHistory.value && versionHistory.value.length === 0) {
            await loadVersionHistory();
        }
    };

    const loadVersionHistory = async () => {
        if (!contract.value?.id) return;
        versionHistoryLoading.value = true;
        try {
            const resp = await fetch(`/api/contracts/${contract.value.id}/versions`);
            const data = await resp.json();
            versionHistory.value = (data.versions || []).map(v => ({
                id: v.id,
                name: v.filename || contract.value.original_filename,
                version: v.version_no,
                modify_time: v.created_at ? Math.floor(new Date(v.created_at).getTime() / 1000) : 0,
            }));
        } catch (error) {
            console.warn('[VersionHistory] Load failed:', error);
            ElMessage.error('加载版本历史失败');
        } finally {
            versionHistoryLoading.value = false;
        }
    };

    const formatVersionTime = (timestamp) => {
        if (!timestamp) return '';
        const d = new Date(timestamp * 1000);
        return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };

    const previewVersion = async (version) => {
        ElMessage.info(`版本 v${version.version}（${formatVersionTime(version.modify_time)}）预览功能开发中，请使用"恢复"加载该版本。`);
    };

    const restoreVersion = async (version) => {
        if (!confirm(`确定要恢复到此版本吗？（${formatVersionTime(version.modify_time)}）当前编辑内容将被覆盖。`)) return;
        try {
            const resp = await fetch(`/api/contracts/${contract.value.id}/restore-version`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ version: version.modify_time }),
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '恢复失败');
            ElMessage.success('版本已恢复，文档将重新加载');
            setTimeout(() => reloadDocument(), 1500);
        } catch (error) {
            console.warn('[RestoreVersion] Error:', error);
            ElMessage.error('恢复版本失败: ' + error.message);
        }
    };

    // ========== Full-provider: Watermark Control ==========
    const toggleWatermarkMenu = () => {
        showWatermarkMenu.value = !showWatermarkMenu.value;
        showVersionHistory.value = false;
        if (!watermarkText.value) {
            watermarkText.value = `合同#${contract.value?.id || ''}`;
        }
    };

    const toggleWatermark = () => {
        if (!watermarkEnabled.value) {
            ElMessage.info('水印已禁用');
        } else {
            applyWatermark();
        }
    };

    const applyWatermark = async () => {
        if (!watermarkEnabled.value) return;
        ElMessage.success(`水印"${watermarkText.value}"已应用到文档`);
        // 水印由后端回调接口 GetFileWatermark 提供，这里只做前端提示
    };

    // ========== Full-provider: Document Reload ==========
    const reloadDocument = async () => {
        if (!contract.value?.id) return;
        try {
            isEditorReady.value = false;
            const numericId = contract.value.id;
            const resp = await fetch(`/api/contracts/${numericId}/editor-config`);
            const data = await resp.json();
            if (data.editorConfig) {
                contract.value = { ...contract.value, editorConfig: data.editorConfig };
                ElMessage.success('文档已刷新');
            } else {
                throw new Error('获取编辑器配置失败');
            }
        } catch (error) {
            console.warn('[ReloadDocument] Error:', error);
            ElMessage.error('刷新文档失败');

        }
    };

    // 修订管理：接受所有修订
    const acceptAllRevisions = async () => {
        if (!ensureEditorReady()) return;
        try {
            const app = await getWpsApplication();
            const doc = app?.ActiveDocument;
            if (!doc?.Revisions) {
                ElMessage.info('当前 WPS 版本不支持修订功能');
                return;
            }
            
            const count = await doc.Revisions.Count;
            if (count === 0) {
                ElMessage.info('文档中没有需要接受的修订');
                return;
            }
            
            if (typeof doc.Revisions.AcceptAll === 'function') {
                await doc.Revisions.AcceptAll();
                ElMessage.success(`已接受 ${count} 处修订`);
            } else {
                // 逐条接受
                let accepted = 0;
                for (let i = 0; i < count; i++) {
                    try {
                        const rev = await doc.Revisions.Item(1); // 每次取第1条，因为接受后会删除
                        if (rev && typeof rev.Accept === 'function') {
                            await rev.Accept();
                            accepted++;
                        }
                    } catch {}
                }
                ElMessage.success(`已接受 ${accepted} 处修订`);
            }
        } catch (error) {
            console.warn('[WPS Connector] acceptAllRevisions failed:', error.message);
            ElMessage.error('接受修订失败');
        }
    };

    // 修订管理：拒绝所有修订
    const rejectAllRevisions = async () => {
        if (!ensureEditorReady()) return;
        try {
            const app = await getWpsApplication();
            const doc = app?.ActiveDocument;
            if (!doc?.Revisions) {
                ElMessage.info('当前 WPS 版本不支持修订功能');
                return;
            }
            
            const count = await doc.Revisions.Count;
            if (count === 0) {
                ElMessage.info('文档中没有需要拒绝的修订');
                return;
            }
            
            if (typeof doc.Revisions.RejectAll === 'function') {
                await doc.Revisions.RejectAll();
                ElMessage.success(`已拒绝 ${count} 处修订`);
            } else {
                // 逐条拒绝
                let rejected = 0;
                for (let i = 0; i < count; i++) {
                    try {
                        const rev = await doc.Revisions.Item(1);
                        if (rev && typeof rev.Reject === 'function') {
                            await rev.Reject();
                            rejected++;
                        }
                    } catch {}
                }
                ElMessage.success(`已拒绝 ${rejected} 处修订`);
            }
        } catch (error) {
            console.warn('[WPS Connector] rejectAllRevisions failed:', error.message);
            ElMessage.error('拒绝修订失败');
        }
    };

    // 修订管理：下拉菜单切换
    const toggleRevisionMenu = () => {
        showRevisionMenu.value = !showRevisionMenu.value;
    };

    // 标记是否需要自动插入批注（从历史记录加载时）
    const needsAutoInsert = ref(false);

    // 审查完成后，由于 WPS WebOffice API 限制（文档只读 + Find.Execute 不可用），
    // 无法在文档中精确定位并插入批注。改用数据库存储批注，定位功能使用段落导航。
    const autoInsertAnnotations = async () => {
        const pdfCheck = isPdfContract.value;
        console.log('[DEBUG] autoInsertAnnotations called, isPdfContract:', pdfCheck, 'suggestions:', reviewData.modification_suggestions?.length);
        
        // PDF 或没有建议时直接返回
        if (pdfCheck || !reviewData.modification_suggestions?.length) {
            return;
        }
        
        // 由于以下限制，不尝试在 WPS 文档中插入批注：
        // 1. 历史合同文档以只读模式打开 (wpsOptions.isReadOnly: false 但服务端可能限制)
        // 2. WebOffice 的 Find.Execute API 不可用，无法精确定位文本
        // 3. Comments.Add(doc.Content, comment) 会添加批注到文档开头而非对应文本位置
        // 
        // 所有批注通过 ReviewAnnotations 组件存储在数据库中，右侧面板显示
        
        ElMessage.info({
            message: `已加载 ${reviewData.modification_suggestions.length} 条审查建议，请在右侧面板查看详情。`,
            duration: 3000
        });
        
        // 可选：在文档开头创建书签，方便快速跳转
        try {
            const app = await getWpsApplication();
            if (!app?.ActiveDocument) return;
            
            const doc = app.ActiveDocument;
            if (doc.Bookmarks && typeof doc.Bookmarks.Add === 'function') {
                // 在文档开头创建书签
                const range = doc.Range(0, 0);
                await doc.Bookmarks.Add('contract_start', range);
                console.log('[Bookmark] Created: contract_start');
            }
        } catch (e) {
            console.warn('[Auto-Annotate] Bookmark creation skipped:', e.message);
        }
    };

    // 添加批注：定位到对应原文位置，同时打开右侧批注输入面板
    const addDocComment = async (text, comment, itemType = 'suggestion', itemIndex = -1) => {
        if (!text) {
            ElMessage.info('请在右侧面板的批注功能中添加意见。');
            return;
        }
        // 打开对应建议项的批注输入面板
        commentingItemKey.value = `${itemType}:${itemIndex}`;
        // 同时尝试在文档中定位（使用 anchor_hint）
        await locateText(text, itemType, itemIndex);
    };

    const adoptSuggestion = (item) => {
        const originalText = suggestionOriginal(item);
        const suggestedText = suggestionText(item);

        if (!originalText || !suggestedText) {
            ElMessage.warning('该建议缺少可自动替换的原文或建议文本，请手动修改。');
            return;
        }

        previewSuggestion(item, '正在采纳');
        replaceTextInEditorFinal(originalText, suggestedText, (result = {}) => {
            item.adopted = true;
            item.adopted_original = originalText;
            adoptedHighlights.value[suggestionTitle(item, 0)] = originalText;
            if (result.fallback) {
                selectedSuggestionPreview.value.status = '已写入源文件，当前页面未刷新';
                ElMessage.success('建议已采纳，源文件已更新；当前页面未刷新。');
            } else {
                selectedSuggestionPreview.value.status = '已实时更新到左侧文档';
                ElMessage.success('建议已采纳，左侧文档已更新。');
            }
        }, (status) => {
            selectedSuggestionPreview.value.status = status;
        }, item);
    };

    const adoptDisputeSuggestion = (item) => {
        const originalText = item.original_clause;
        const suggestedText = item.suggested_text;

        if (!originalText || !suggestedText) {
            ElMessage.warning('该风险点缺少可自动替换的原文或建议文本，请手动修改。');
            return;
        }

        selectedSuggestionPreview.value = {
            before: originalText,
            after: suggestedText,
            status: '正在采纳',
        };

        replaceTextInEditor(originalText, suggestedText, (result = {}) => {
            item.adopted = true;
            item.adopted_original = originalText;
            adoptedHighlights.value[item.title] = originalText;
            if (result.fallback) {
                selectedSuggestionPreview.value.status = '已写入源文件，当前页面未刷新';
                ElMessage.success('风险点建议已采纳，源文件已更新；当前页面未刷新。');
            } else {
                selectedSuggestionPreview.value.status = '已实时更新到左侧文档';
                ElMessage.success('风险点建议已采纳，左侧文档已更新。');
            }
        }, (status) => {
            selectedSuggestionPreview.value.status = status;
        }, item);
    };

    const downloadBlob = (blob, filename) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const applySelectedSuggestions = async () => {
        const indexes = selectedSuggestionIndexes.value;
        if (!indexes.length) {
            ElMessage.warning('请选择要批量采纳的修改建议。');
            return;
        }
        batchApplying.value = true;
        try {
            const suggestions = indexes.map((index) => {
                const item = reviewData.modification_suggestions[index];
                return {
                    originalText: suggestionOriginal(item),
                    suggestedText: suggestionText(item),
                    originalCandidates: buildSuggestionCandidates(suggestionOriginal(item), item),
                };
            });
            const response = await api.batchReplaceContractText(contract.id, { suggestions });
            if (response.data.editorConfig) contract.editorConfig = response.data.editorConfig;
            indexes.forEach((index) => {
                if (reviewData.modification_suggestions[index]) reviewData.modification_suggestions[index].adopted = true;
            });
            ElMessage.success(`批量采纳完成，成功替换 ${response.data.totalReplacements || 0} 处。`);
            await loadLatestDiff();
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '批量采纳失败。');
        } finally {
            batchApplying.value = false;
        }
    };

    const loadLatestDiff = async () => {
        if (!contract.id) return;
        diffLoading.value = true;
        try {
            const response = await api.getContractDiff(contract.id);
            diffItems.value = response.data.diff || [];
            activeAiTab.value = 'workspace';
        } catch (error) {
            ElMessage.info(error.response?.data?.error || '暂无可对比的合同版本。');
        } finally {
            diffLoading.value = false;
        }
    };

    const exportReport = async (format = 'html') => {
        try {
            const response = await api.exportReviewReport(contract.id, format);
            downloadBlob(response.data, `合同审查报告.${format === 'word' ? 'doc' : format}`);
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出审查报告失败。');
        }
    };

    const downloadPdfAnnotations = async () => {
        try {
            const response = await api.downloadPdfAnnotations(contract.id);
            downloadBlob(response.data, 'PDF批注意见.txt');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出 PDF 批注意见失败。');
        }
    };

    const exportAnnotatedDocx = async () => {
        try {
            ElMessage.info('正在导出带批注的文档...');
            // 批注已在审查完成后由后端直接写入DOCX文件，无需再次触发WPS保存
            const response = await api.exportAnnotatedDocx(contract.id);
            const filename = response.headers['content-disposition']
                ? decodeURIComponent(response.headers['content-disposition'].split('filename=')[1]?.replace(/"/g, '') || '批注版.docx')
                : '批注版.docx';
            downloadBlob(response.data, filename);
            ElMessage.success('带批注的 Word 文档已导出。');
        } catch (error) {
            ElMessage.error(error.response?.data?.error || '导出带批注 Word 失败。');

        }
    };

    return {
      activeStep,
      loading,
      preAnalyzing,
      loadingMessage,
      sessionLoadFailed,
      retryLoadSession,
      contract,
      perspective,
      reviewData,
      activeAiTab,
      handleBeforeUpload,
      handleUploadSuccess,
      handleUploadError,
      handleLinkedFilesChange,
      openLinkedFilePicker,
      startLinkedContractAnalysis,
      linkedGroupFiles,
      linkedAnalysisLoading,
      linkedAnalysisResult,
      linkedAnalysisProgress,
      linkedFileInput,
      goBackToUpload,
      goBackToConfirm,
      startAnalysis,
      analysisPercent,
      analysisEta,
      analysisElapsed,
      analysisActive,
      analysisSteps,
      analysisJobId,
      formatDuration,
      wpsInstance,
      wpsApp,
      isEditorReady,
      preAnalysisData,
      selectedReviewPoints,
      customPurposes,
      showContractPreview,
      contractPreviewText,
      qaPanelOpen,
      qaInput,
      qaMessages,
      qaLoading,
      qaChatBody,
      toggleQaPanel,
      sendQaMessage,
      handleQaEnter,
      clearQaChat,
      renderQaMarkdown,
      addPurpose,
      removePurpose,
      reAnalyzing,
      startReAnalysis,
      uploadAndGo,
      cameFromHistory,
      goBackSmart,
      goToQnA,

      allSuggestedReviewPoints,
      allPotentialParties,
      reviewTemplates,
      selectedTemplateId,
      querySearchCorePurposes,
      onDocumentReady,
      onDocumentStateChange,
      editMode,
      onEditorError,

      showPlainLanguage,
      showRevisionMenu,
      toggleRevisionMenu,
      selectedSuggestionPreview,
      focusedReviewText,
      focusedReviewQuestion,
      focusedReviewResult,
      focusedReviewLoading,
      focusedReviewHistory,
      focusedReviewHistoryLoading,
      loadFocusedReviewFromHistory,
      deleteFocusedReviewFromHistory,
      formatHistoryTime,
      disputeTitle,
      disputeDescription,
      missingClauseTitle,
      partyReviewTitle,
      partyReviewDescription,
      suggestionTitle,
      suggestionOriginal,
      suggestionText,
      suggestionReason,
      previewSuggestion,
      prepareFocusedReviewFromSelection,
      submitFocusedReview,
      applyFocusedSuggestion,
      locateText,
      addDocComment,
      gotoDisputeBookmark,
      addReviewCommentByDisputeBookmark,
      adjustReplaceByDisputeBookmark,
      adoptSuggestion,
      adoptDisputeSuggestion,
      acceptAllRevisions,
      rejectAllRevisions,
      highlightCurrentRange,
      addBookmark,
      jumpToBookmark,
      analysisProgress,
      visibleAnalysisProgress,
      isPdfContract,
      severityFilter,
      filteredAndSortedDisputePoints,
      disputeSeverityStats,
      riskDashboardData,
      riskScoreLoading,
      getAnnotations,
      getAnnotationSummary,
      handleAddAnnotation,
      commentingItemKey,
      userId,
      normalizeSeverity,
      severityLabel,
      severityClass,
      progressStepLabel,
      progressStatusLabel,
      progressStatusClass,
      selectedSuggestionIndexes,
      batchApplying,
      applySelectedSuggestions,
      diffItems,
      diffLoading,
      loadLatestDiff,
      exportReport,
      downloadPdfAnnotations,
      exportAnnotatedDocx,
      autoInsertAnnotations,
      wpsEditorRef,
      // --- Full-provider: Left Panel ---
      showVersionHistory,
      versionHistory,
      versionHistoryLoading,
      toggleVersionHistory,
      loadVersionHistory,
      previewVersion,
      restoreVersion,
      formatVersionTime,
      showWatermarkMenu,
      watermarkEnabled,
      watermarkText,
      toggleWatermarkMenu,
      toggleWatermark,
      applyWatermark,
      reloadDocument,
    };
  }
};
</script>

<style>
/* Add global overrides for Element Plus components we are keeping */
/* Select Dropdown */
.el-select-dropdown {
  @apply rounded-lg shadow-lg border border-border-color;
}
.el-select-dropdown__item {
  @apply text-text-main;
}
.el-select-dropdown__item.hover, .el-select-dropdown__item:hover {
  @apply bg-primary-light text-primary-dark;
}
.el-select-dropdown__item.selected {
  @apply text-primary-dark font-semibold;
}

/* Checkbox */
.el-checkbox.is-bordered {
 @apply bg-white border-border-color hover:border-primary;
}
.el-checkbox.is-bordered.is-checked {
  @apply border-primary;
}
.el-checkbox__inner {
  @apply border-border-color;
}
.el-checkbox__input.is-checked .el-checkbox__inner, .el-checkbox__input.is-indeterminate .el-checkbox__inner {
  @apply bg-primary border-primary;
}
.el-checkbox__label {
  @apply text-text-main;
}
.el-checkbox__input.is-checked+.el-checkbox__label {
  @apply text-primary;
}

/* Input */
.el-input__wrapper {
  @apply rounded-md border border-border-color shadow-sm transition-colors duration-200 ease-in-out focus-within:border-primary focus-within:ring-1 focus-within:ring-primary;
}

.diff-insert {
  background: #dcfce7;
  color: #166534;
  text-decoration: none;
}

.diff-delete {
  background: #fee2e2;
  color: #991b1b;
  text-decoration: line-through;
}

.analysis-progress {
  position: relative;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f8fafc;
  padding: 12px;
}

.analysis-progress__item {
  position: relative;
  display: flex;
  gap: 10px;
  padding-bottom: 12px;
}

.analysis-progress__item:last-child {
  padding-bottom: 0;
}

.analysis-progress__item::after {
  content: '';
  position: absolute;
  left: 9px;
  top: 22px;
  bottom: 0;
  width: 2px;
  background: #d1d5db;
}

.analysis-progress__item:last-child::after {
  display: none;
}

.analysis-progress__marker {
  position: relative;
  z-index: 1;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 999px;
  border: 2px solid #94a3b8;
  background: #fff;
  color: #fff;
  font-size: 12px;
  line-height: 16px;
  text-align: center;
}

.analysis-progress__item--running .analysis-progress__marker {
  border-color: #2563eb;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
}

.analysis-progress__item--pending .analysis-progress__marker {
  border-color: #cbd5e1;
  background: #f1f5f9;
  color: #94a3b8;
}

.analysis-progress__item--pending .analysis-progress__status {
  color: #94a3b8;
}

.analysis-progress__spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 2px solid rgba(37, 99, 235, 0.3);
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: analysis-spin 0.8s linear infinite;
}

@keyframes analysis-spin {
  to { transform: rotate(360deg); }
}

.analysis-progress__item--completed .analysis-progress__marker {
  background: #16a34a;
  border-color: #16a34a;
}

.analysis-progress__item--failed .analysis-progress__marker {
  background: #dc2626;
  border-color: #dc2626;
}

/* ========== 审查动态效果 ========== */

/* 进度条流光动画 */
.analysis-progress-bar-shimmer {
  background: linear-gradient(
    90deg,
    #2563eb 0%,
    #60a5fa 30%,
    #93c5fd 50%,
    #60a5fa 70%,
    #2563eb 100%
  );
  background-size: 200% 100%;
  animation: shimmer-slide 1.8s linear infinite;
}
@keyframes shimmer-slide {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* 正在运行步骤标记：脉冲发光 */
.analysis-progress__item--running .analysis-progress__marker {
  border-color: #2563eb;
  animation: marker-pulse-glow 1.8s ease-in-out infinite;
}
@keyframes marker-pulse-glow {
  0%, 100% {
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
  }
  50% {
    box-shadow: 0 0 0 7px rgba(37, 99, 235, 0.25), 0 0 12px rgba(37, 99, 235, 0.3);
  }
}

/* 步骤入场动画 */
.analysis-progress__item--running,
.analysis-progress__item--completed,
.analysis-progress__item--failed {
  animation: step-enter 0.35s ease-out;
}
@keyframes step-enter {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 连接线：步骤完成后从灰变绿动画 */
.analysis-progress__item--completed::after {
  background: #16a34a;
  animation: line-fill 0.5s ease-out forwards;
}
@keyframes line-fill {
  from { transform: scaleY(0); transform-origin: top; }
  to   { transform: scaleY(1); transform-origin: top; }
}

/* AI思考中省略号动画（替代文字"进行中"） */
.analysis-thinking-dots {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 14px;
}
.analysis-thinking-dots span {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #2563eb;
  animation: thinking-bounce 1.2s ease-in-out infinite;
}
.analysis-thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.analysis-thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes thinking-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-5px); opacity: 1; }
}

/* 进度百分比数字滚动效果 */
.analysis-percent-counter {
  display: inline-block;
  transition: transform 0.15s ease-out;
}
.analysis-percent-counter.tick {
  animation: percent-pop 0.2s ease-out;
}
@keyframes percent-pop {
  0%  { transform: scale(1); }
  50% { transform: scale(1.15); }
  100%{ transform: scale(1); }
}

/* 审查完成时的庆祝动画 */
.analysis-progress__item--completed .analysis-progress__marker {
  animation: completed-pop 0.4s ease-out;
}
@keyframes completed-pop {
  0%   { transform: scale(0.6); opacity: 0.5; }
  70%  { transform: scale(1.15); }
  100% { transform: scale(1); opacity: 1; }
}

.analysis-progress__content {
  min-width: 0;
  flex: 1;
}

.analysis-progress__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  font-weight: 700;
  color: #111827;
}

.analysis-progress__status {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: #2563eb;
}

.analysis-progress__item--completed .analysis-progress__status {
  color: #16a34a;
}

.analysis-progress__item--failed .analysis-progress__status {
  color: #dc2626;
}

.analysis-progress__message {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.45;
  color: #64748b;
}

.linked-analysis-panel {
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  padding: 20px;
  margin-bottom: 32px;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.08);
}

.linked-analysis-panel__picker {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 16px;
}

.linked-analysis-panel__native-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.linked-analysis-panel__file-button {
  flex: 0 0 auto;
  border: 1px solid #2563eb;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 700;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.linked-analysis-panel__file-button:hover {
  background: #dbeafe;
  border-color: #1d4ed8;
}

.linked-analysis-panel__count {
  flex: 1;
  min-width: 0;
  color: #64748b;
  font-size: 12px;
}

.linked-analysis-panel__button {
  flex: 0 0 auto;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  padding: 10px 16px;
  font-size: 12px;
  font-weight: 700;
  transition: background 0.2s ease, opacity 0.2s ease;
}

.linked-analysis-panel__button:hover:not(:disabled) {
  background: #1d4ed8;
}

.linked-analysis-panel__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.linked-analysis-panel__files {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.linked-analysis-panel__files span {
  border-radius: 8px;
  background: #e0f2fe;
  color: #075985;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
}

.linked-analysis-panel__progress {
  display: grid;
  gap: 10px;
  margin-top: 14px;
  border-radius: 8px;
  background: #fff;
  padding: 12px;
}

.linked-analysis-panel__progress-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.linked-analysis-panel__progress-row strong {
  display: block;
  color: #111827;
  font-size: 12px;
}

.linked-analysis-panel__progress-row p {
  margin-top: 2px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.45;
}

.linked-analysis-panel__progress-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  margin-top: 4px;
  border-radius: 999px;
  background: #94a3b8;
}

.linked-analysis-panel__progress-dot--running {
  background: #2563eb;
  box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.12);
}

.linked-analysis-panel__progress-dot--done {
  background: #16a34a;
}

.linked-analysis-panel__progress-dot--failed {
  background: #dc2626;
}

.linked-analysis-result {
  margin-top: 16px;
  border-top: 1px solid #e5e7eb;
  padding-top: 14px;
}

.linked-analysis-result h3,
.linked-analysis-result h4 {
  color: #111827;
  font-weight: 700;
}

.linked-analysis-result h3 {
  font-size: 15px;
}

.linked-analysis-result h4 {
  margin-top: 12px;
  font-size: 13px;
}

.linked-analysis-result__summary {
  margin-top: 8px;
  color: #475569;
  font-size: 12px;
  line-height: 1.6;
}

.linked-analysis-result__item {
  margin-top: 8px;
  border-left: 3px solid #2563eb;
  background: #fff;
  padding: 10px 12px;
  border-radius: 6px;
}

.linked-analysis-result__item p,
.linked-analysis-result li {
  margin-top: 4px;
  color: #475569;
  font-size: 12px;
  line-height: 1.55;
}

.linked-analysis-result ul {
  margin-top: 6px;
  padding-left: 18px;
}

@media (max-width: 640px) {
  .linked-analysis-panel__picker {
    align-items: stretch;
    flex-direction: column;
  }

  .linked-analysis-panel__button {
    width: 100%;
  }
}

/* --- Inline Q&A Chat Widget --- */
.qa-chat-widget {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 100;
}

.reanalysis-progress .analysis-progress {
  max-height: 280px;
  overflow-y: auto;
}

.qa-chat-widget__fab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(37, 99, 235, 0.35);
  transition: transform 0.2s, box-shadow 0.2s;
  justify-content: center;
}

.qa-chat-widget__fab:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(37, 99, 235, 0.45);
}

.qa-chat-widget__fab-badge {
  display: none;
}

.qa-chat-widget__panel {
  width: 400px;
  height: 520px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 120px);
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e5e7eb;
}

.qa-chat-widget__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid #e5e7eb;
  background: #f8fafc;
  flex-shrink: 0;
}

.qa-chat-widget__body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  background: linear-gradient(180deg, #fafafa 0%, #ffffff 100%);
}

.qa-chat-widget__empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 4px;
}

.qa-chat-widget__msg {
  display: flex;
  margin-bottom: 10px;
  min-width: 0;
}

.qa-chat-widget__msg--user {
  justify-content: flex-end;
}

.qa-chat-widget__msg--assistant {
  justify-content: flex-start;
}

.qa-chat-widget__bubble {
  max-width: 85%;
  min-width: 0;
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  box-shadow: inset 0 0 0 1px #e5e7eb;
  word-break: break-word;
  overflow-wrap: break-word;
}

.qa-chat-widget__msg--user .qa-chat-widget__bubble {
  background: #2563eb;
  color: #fff;
  box-shadow: none;
}

.qa-chat-widget__role {
  margin: 0 0 3px;
  font-size: 11px;
  font-weight: 700;
  opacity: 0.7;
}

.qa-chat-widget__content {
  font-size: 13px;
  line-height: 1.55;
}

.qa-chat-widget__content :deep(p) {
  margin: 0 0 4px;
}

.qa-chat-widget__content :deep(p:last-child) {
  margin-bottom: 0;
}

.qa-chat-widget__typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
}

.qa-chat-widget__typing span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
  animation: qa-typing-pulse 1s infinite ease-in-out;
}

.qa-chat-widget__typing span:nth-child(2) {
  animation-delay: 0.15s;
}

.qa-chat-widget__typing span:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes qa-typing-pulse {
  0%, 100% { opacity: 0.35; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-3px); }
}

.qa-chat-widget__footer {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #e5e7eb;
  background: #fff;
  flex-shrink: 0;
}

.qa-chat-widget__footer .el-input {
  flex: 1;
}

.qa-chat-widget__send {
  flex: 0 0 auto;
  border: 0;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-weight: 700;
  font-size: 13px;
  padding: 0 16px;
  cursor: pointer;
}

.qa-chat-widget__send:disabled {
  background: #a3a3a3;
  cursor: not-allowed;
}

@media (max-width: 640px) {
  .qa-chat-widget__panel {
    width: calc(100vw - 32px);
    height: calc(100vh - 100px);
  }
}
</style>

<style scoped>
/* Using Tailwind utility classes, so scoped styles are minimal. */
/* You can add specific component-level styles here if needed. */

:deep(.text-3xl) {
  font-size: 24px !important;
  line-height: 1.2 !important;
}

:deep(.sm\:text-4xl) {
  font-size: 28px !important;
  line-height: 1.18 !important;
}

:deep(.text-lg) {
  font-size: 15px !important;
  line-height: 1.35 !important;
}

:deep(.text-md),
:deep(.text-base) {
  font-size: 13px !important;
  line-height: 1.45 !important;
}

:deep(.text-sm) {
  font-size: 12px !important;
  line-height: 1.45 !important;
}

:deep(.text-xs) {
  font-size: 11px !important;
  line-height: 1.35 !important;
}

:deep(.p-10) {
  padding: 24px !important;
}

:deep(.p-6) {
  padding: 14px !important;
}

:deep(.p-4) {
  padding: 10px !important;
}

:deep(.p-3) {
  padding: 8px !important;
}

:deep(.py-8) {
  padding-top: 18px !important;
  padding-bottom: 18px !important;
}

:deep(.px-4) {
  padding-left: 10px !important;
  padding-right: 10px !important;
}

:deep(.py-2) {
  padding-top: 6px !important;
  padding-bottom: 6px !important;
}

:deep(.mt-10) {
  margin-top: 22px !important;
}

:deep(.mt-8) {
  margin-top: 14px !important;
}

:deep(.mt-6) {
  margin-top: 10px !important;
}

:deep(.mt-4) {
  margin-top: 8px !important;
}

:deep(.mt-3),
:deep(.mt-2) {
  margin-top: 6px !important;
}

:deep(.mb-10) {
  margin-bottom: 16px !important;
}

:deep(.mb-6) {
  margin-bottom: 10px !important;
}

:deep(.mb-4) {
  margin-bottom: 8px !important;
}

:deep(.gap-8) {
  gap: 12px !important;
}

:deep(.gap-4),
:deep(.space-x-4 > :not([hidden]) ~ :not([hidden])) {
  gap: 10px !important;
  margin-left: 10px !important;
}

:deep(.gap-3) {
  gap: 8px !important;
}

:deep(.space-y-6 > :not([hidden]) ~ :not([hidden])) {
  margin-top: 12px !important;
}

:deep(.space-y-4 > :not([hidden]) ~ :not([hidden])) {
  margin-top: 8px !important;
}

:deep(.rounded-lg),
:deep(.rounded-md) {
  border-radius: 8px !important;
}

:deep(.shadow-md) {
  box-shadow: inset 0 0 0 1px #e5e5e5, 0 8px 22px rgba(0, 0, 0, 0.04) !important;
}

:deep(.h-\[calc\(100vh-85px\)\]) {
  height: calc(100vh - 72px) !important;
}

:deep(.el-checkbox.is-bordered) {
  padding: 5px 9px !important;
  height: auto !important;
}

:deep(.el-checkbox-group) {
  gap: 6px !important;
}

.review-page {
  height: calc(100vh - 56px);
  overflow: hidden;
  padding: 8px 10px 10px;
  font-size: 13px;
}

.confirm-step {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  padding-left: 8px;
  padding-right: 8px;
  padding-bottom: 28px !important;
}

.review-options-panel {
  overflow: visible;
}

.review-points-group {
  max-height: none;
  overflow: visible;
  align-items: flex-start;
}

.purpose-row {
  min-width: 0;
}

.purpose-row :deep(.el-autocomplete) {
  min-width: 0;
}

.adopted-suggestion-text {
  background: #fef3c7 !important;
  border-color: #f59e0b !important;
  color: #166534 !important;
  box-shadow: inset 0 0 0 1px #facc15;
  cursor: help;
}

.upload-dragger .el-upload-dragger {
  @apply bg-bg-subtle border-2 border-dashed border-border-color rounded-lg transition-colors duration-200 ease-in-out;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 132px;
  width: 100%;
}

.upload-dragger .el-upload-dragger:hover {
  @apply border-primary;
}
</style>
