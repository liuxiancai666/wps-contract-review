import { ref, shallowRef, reactive, computed } from 'vue';
import api from '../api';

/**
 * 审查会话状态管理 composable
 * 管理步骤、合同信息、预分析/审查数据，支持 localStorage 持久化
 */
export function useReviewSession() {
  // 步骤：0=上传, 1=确认, 2=审查
  const activeStep = ref(0);
  const cameFromHistory = ref(false);
  const loading = ref(false);
  const loadingMessage = ref('');
  const sessionLoadFailed = ref(false);
  const preAnalyzing = ref(false);
  const perspective = ref('');
  const activeAiTab = ref('summary');
  const isEditorReady = ref(false);
  const reAnalyzing = ref(false);
  const showPlainLanguage = ref(false);
  const docEditorComponent = ref(null);

  // 合同核心数据（浅响应，避免深度遍历开销）
  const initialContractState = {
    id: null,
    original_filename: '',
    editorConfig: null,
  };
  const contract = shallowRef({ ...initialContractState });

  // 预分析和审查结果（shallowRef 避免深度响应式代理）
  const preAnalysisData = shallowRef({
    contract_type: '',
    potential_parties: [],
    suggested_review_points: [],
    suggested_core_purposes: [],
    template_id: '',
    template_name: '',
  });

  const reviewData = shallowRef({});
  const riskDashboard = reactive({ total: 0, overallLabel: '', overallClass: '', stats: { high: 0, medium: 0, low: 0 }, moduleCounts: { disputes: 0, suggestions: 0, missing: 0, breach: 0, party: 0 } });

  const reviewTemplates = shallowRef([]);
  const selectedTemplateId = ref('');
  const allSuggestedReviewPoints = shallowRef([]);
  const allPotentialParties = shallowRef([]);
  const allSuggestedCorePurposes = shallowRef([]);
  const customPurposes = shallowRef([{ value: '' }]);
  const selectedSuggestionPreview = shallowRef(null);
  const adoptedHighlights = shallowRef({});
  const diffItems = shallowRef([]);
  const diffLoading = ref(false);

  // 历史记录
  const historyList = shallowRef([]);
  const historyLoading = ref(false);

  // 聚焦审查
  const focusedReviewText = ref('');
  const focusedReviewQuestion = ref('');
  const focusedReviewResult = shallowRef(null);
  const focusedReviewLoading = ref(false);
  const focusedReviewHistory = shallowRef([]);
  const focusedReviewHistoryLoading = ref(false);

  // 多合同关联分析
  const linkedGroupFiles = shallowRef([]);
  const linkedAnalysisLoading = ref(false);
  const linkedAnalysisResult = shallowRef(null);
  const linkedAnalysisProgress = shallowRef([]);

  // 保存会话
  const SESSION_KEY = 'review_session';

  const saveState = () => {
    try {
      const state = {
        activeStep: activeStep.value,
        contract: contract.value,
        perspective: perspective.value,
        preAnalysisData: preAnalysisData.value,
        reviewData: reviewData.value,
        activeAiTab: activeAiTab.value,
        showPlainLanguage: showPlainLanguage.value,
        selectedTemplateId: selectedTemplateId.value,
        selectedSuggestionPreview: selectedSuggestionPreview.value,
        adoptedHighlights: adoptedHighlights.value,
        customPurposes: customPurposes.value,
        cameFromHistory: cameFromHistory.value,
        preAnalysisDataFields: {
          contract_type: preAnalysisData.value.contract_type,
          suggested_review_points: preAnalysisData.value.suggested_review_points,
          potential_parties: preAnalysisData.value.potential_parties,
          suggested_core_purposes: preAnalysisData.value.suggested_core_purposes,
        },
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[Session] Save failed:', e.message);
    }
  };

  const loadState = () => {
    try {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return null;
      const state = JSON.parse(saved);
      if (!state || !state.contract?.id) return null;
      return state;
    } catch {
      return null;
    }
  };

  const resetState = () => {
    activeStep.value = 0;
    contract.value = { ...initialContractState };
    preAnalysisData.value = { contract_type: '', potential_parties: [], suggested_review_points: [], suggested_core_purposes: [], template_id: '', template_name: '' };
    reviewData.value = {};
    perspective.value = '';
    selectedTemplateId.value = '';
    allSuggestedReviewPoints.value = [];
    allPotentialParties.value = [];
    allSuggestedCorePurposes.value = [];
    customPurposes.value = [{ value: '' }];
    selectedSuggestionPreview.value = null;
    adoptedHighlights.value = {};
    diffItems.value = [];
    historyList.value = [];
    cameFromHistory.value = false;
    isEditorReady.value = false;
    preAnalyzing.value = false;
    reAnalyzing.value = false;
    focusedReviewText.value = '';
    focusedReviewQuestion.value = '';
    focusedReviewResult.value = null;
    linkedGroupFiles.value = [];
    linkedAnalysisResult.value = null;
    linkedAnalysisProgress.value = [];
    activeAiTab.value = 'summary';
    showPlainLanguage.value = false;
    loading.value = false;
    loadingMessage.value = '';
    localStorage.removeItem(SESSION_KEY);
  };

  const isPdfContract = computed(() => {
    const name = String(contract.value?.original_filename || '').toLowerCase();
    return name.endsWith('.pdf');
  });

  return {
    // 状态
    activeStep, cameFromHistory, loading, loadingMessage,
    sessionLoadFailed, preAnalyzing, perspective, activeAiTab,
    isEditorReady, reAnalyzing, showPlainLanguage, docEditorComponent,
    // 数据
    contract, preAnalysisData, reviewData, riskDashboard,
    reviewTemplates, selectedTemplateId,
    allSuggestedReviewPoints, allPotentialParties, allSuggestedCorePurposes,
    customPurposes, selectedSuggestionPreview, adoptedHighlights,
    diffItems, diffLoading,
    historyList, historyLoading,
    focusedReviewText, focusedReviewQuestion, focusedReviewResult,
    focusedReviewLoading, focusedReviewHistory, focusedReviewHistoryLoading,
    linkedGroupFiles, linkedAnalysisLoading, linkedAnalysisResult, linkedAnalysisProgress,
    // 方法
    saveState, loadState, resetState, isPdfContract,
    SESSION_KEY,
  };
}
