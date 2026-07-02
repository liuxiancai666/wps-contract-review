import { ref, onUnmounted } from 'vue';
import { io } from 'socket.io-client';

/**
 * Socket.io 实时分析通信 composable
 * 管理分析进度推送、断线轮询恢复
 */
export function useSocketAnalysis() {
  const socket = ref(null);
  const analysisActive = ref(false);
  const analysisPercent = ref(0);
  const analysisEta = ref(0);
  const analysisElapsed = ref(0);
  const analysisSteps = ref([]);
  const analysisProgress = ref([]);
  const statusPollTimer = ref(null);

  let stopStatusPolling = null;
  let pollingFn = null;

  const setupSocket = (contractId, callbacks = {}) => {
    if (socket.value) {
      socket.value.disconnect();
      socket.value = null;
    }

    const backendUrl = import.meta.env.VITE_APP_BACKEND_API_URL || 'http://localhost:3000';
    socket.value = io(backendUrl);

    socket.value.on('connect', () => {
      console.log('[Socket] Connected, joining contract room');
      socket.value.emit('join-contract', contractId);
    });

    socket.value.on('connect_error', (error) => {
      console.error('[Socket] Connection failed:', error.message);
      callbacks.onConnectError?.(error);
    });

    socket.value.on('analysis-complete', (data) => {
      console.log('[Socket] Analysis complete');
      analysisActive.value = false;
      analysisPercent.value = 100;
      if (stopStatusPolling) stopStatusPolling();
      callbacks.onComplete?.(data);
    });

    socket.value.on('analysis-progress', (data) => {
      analysisProgress.value.push(data);
      if (typeof data.percent === 'number') analysisPercent.value = data.percent;
      if (typeof data.estimatedRemainingSeconds === 'number') analysisEta.value = data.estimatedRemainingSeconds;
      if (typeof data.elapsedSeconds === 'number') analysisElapsed.value = data.elapsedSeconds;

      if (Array.isArray(data.steps)) {
        analysisSteps.value = data.steps;
      } else if (data.step && data.status) {
        analysisSteps.value = analysisSteps.value.map((s) =>
          s.key === data.step ? { ...s, status: data.status, message: data.message || s.message || '' } : s
        );
      }
      if (data.partialResult) {
        callbacks.onPartialResult?.(data.partialResult);
      }
      callbacks.onProgressMessage?.(data.message);
    });

    socket.value.on('analysis-failed', (data) => {
      analysisActive.value = false;
      if (stopStatusPolling) stopStatusPolling();
      callbacks.onFailed?.(data);
    });

    socket.value.on('disconnect', () => {
      console.log('[Socket] Disconnected, starting polling fallback');
      if (analysisActive.value && pollingFn) {
        stopStatusPolling = startStatusPolling(contractId, callbacks);
      }
    });
  };

  const startStatusPolling = (contractId, callbacks) => {
    const timer = setInterval(async () => {
      try {
        const { default: api } = await import('../api');
        const { getUserId } = await import('../user');
        const response = await api.getAnalyzeStatus(contractId);
        const data = response.data;
        if (!data) return;
        if (data.status === 'completed') {
          analysisActive.value = false;
          analysisPercent.value = 100;
          clearInterval(timer);
          callbacks.onComplete?.({ results: data.result, perspective: data.perspective });
        } else if (data.status === 'failed') {
          analysisActive.value = false;
          clearInterval(timer);
          callbacks.onFailed?.({ error: data.error || '分析失败' });
        } else {
          if (typeof data.percent === 'number') analysisPercent.value = data.percent;
          if (Array.isArray(data.steps)) analysisSteps.value = data.steps;
        }
      } catch (e) {
        console.warn('[Polling] Status check failed:', e.message);
      }
    }, 3000);
    return () => clearInterval(timer);
  };

  const disconnect = () => {
    if (stopStatusPolling) stopStatusPolling();
    if (socket.value) {
      socket.value.disconnect();
      socket.value = null;
    }
  };

  onUnmounted(disconnect);

  return {
    socket,
    analysisActive,
    analysisPercent,
    analysisEta,
    analysisElapsed,
    analysisSteps,
    analysisProgress,
    setupSocket,
    startStatusPolling,
    setPollingFn: (fn) => { pollingFn = fn; },
    setStopPolling: (fn) => { stopStatusPolling = fn; },
    disconnect,
  };
}
