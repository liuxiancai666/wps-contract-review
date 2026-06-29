<template>
  <div class="risk-dashboard p-4 bg-white rounded-md border border-border-color mb-4">
    <!-- 整体风险评分 -->
    <div class="flex items-center justify-between flex-wrap gap-4 mb-4">
      <div class="flex items-center gap-4">
        <div class="text-center">
          <div class="relative w-20 h-20">
            <svg viewBox="0 0 36 36" class="w-20 h-20 -rotate-90">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" stroke-width="2.5"/>
              <circle cx="18" cy="18" r="15.9" fill="none" :stroke="scoreColor" stroke-width="2.5"
                :stroke-dasharray="circumference" :stroke-dashoffset="scoreOffset"
                stroke-linecap="round"/>
            </svg>
            <div class="absolute inset-0 flex items-center justify-center">
              <span class="text-2xl font-bold" :class="scoreTextClass">{{ overallScore }}</span>
            </div>
          </div>
          <p class="text-xs text-text-light mt-1">风险评分</p>
        </div>
        <div>
          <span :class="levelClass" class="px-3 py-1 text-sm font-bold rounded-full border">{{ overallLabel }}</span>
          <p class="text-xs text-text-light mt-1">整体风险等级</p>
        </div>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <div class="flex items-center gap-1">
          <span class="w-2.5 h-2.5 rounded-full bg-red-500"></span>
          <span class="text-text-main">高危 {{ severityDist['高'] || 0 }}</span>
        </div>
        <div class="flex items-center gap-1">
          <span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
          <span class="text-text-main">中危 {{ severityDist['中'] || 0 }}</span>
        </div>
        <div class="flex items-center gap-1">
          <span class="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
          <span class="text-text-main">低危 {{ severityDist['低'] || 0 }}</span>
        </div>
      </div>
    </div>

    <!-- 严重程度分布条形图 -->
    <div v-if="totalItems > 0" class="mb-4">
      <div class="flex h-4 rounded-full overflow-hidden text-[0px]">
        <div v-if="severityDist['高'] > 0" class="bg-red-500 transition-all" :style="{ width: highPct + '%' }"
          :title="'高危: ' + severityDist['高']"></div>
        <div v-if="severityDist['中'] > 0" class="bg-amber-500 transition-all" :style="{ width: midPct + '%' }"
          :title="'中危: ' + severityDist['中']"></div>
        <div v-if="severityDist['低'] > 0" class="bg-blue-500 transition-all" :style="{ width: lowPct + '%' }"
          :title="'低危: ' + severityDist['低']"></div>
      </div>
      <div class="flex justify-between text-xs text-text-light mt-1">
        <span>风险分布</span>
        <span>共 {{ totalItems }} 项</span>
      </div>
    </div>

    <!-- 类别概览格 -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
      <div v-for="cat in categoryCards" :key="cat.key"
        class="p-2 rounded text-center cursor-pointer transition-colors hover:bg-gray-50"
        :class="cat.count > 0 ? 'bg-bg-subtle' : 'bg-gray-50 opacity-60'"
        @click="$emit('select-tab', cat.tab)">
        <p class="text-lg font-bold" :class="cat.count > 0 ? 'text-text-dark' : 'text-text-light'">{{ cat.count }}</p>
        <p class="text-xs text-text-light">{{ cat.label }}</p>
      </div>
    </div>

    <!-- 五维度评分（替代雷达图，纯CSS条形） -->
    <div v-if="radarData && radarData.length" class="space-y-2">
      <p class="text-xs font-medium text-text-light mb-2">各维度评估</p>
      <div v-for="dim in radarData" :key="dim.axis" class="flex items-center gap-2">
        <span class="text-xs text-text-light w-16 flex-shrink-0">{{ dim.axis }}</span>
        <div class="flex-1 h-3 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-500"
            :style="{ width: dim.value + '%' }"
            :class="dim.value >= 70 ? 'bg-red-400' : dim.value >= 40 ? 'bg-amber-400' : 'bg-green-400'">
          </div>
        </div>
        <span class="text-xs font-mono w-8 text-right"
          :class="dim.value >= 70 ? 'text-red-600' : dim.value >= 40 ? 'text-amber-600' : 'text-green-600'">
          {{ dim.value }}
        </span>
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue';

export default {
  name: 'RiskDashboard',
  props: {
    overallScore: { type: Number, default: 0 },
    overallLevel: { type: String, default: 'low' },
    overallLabel: { type: String, default: '低风险' },
    severityDist: { type: Object, default: () => ({ 高: 0, 中: 0, 低: 0 }) },
    radarData: { type: Array, default: () => [] },
    stats: { type: Object, default: () => ({}) },
    categoryRisk: { type: Object, default: () => ({}) },
    loading: { type: Boolean, default: false },
  },
  emits: ['select-tab'],
  setup(props) {
    const circumference = 100;
    const scoreOffset = computed(() => circumference - (props.overallScore / 100) * circumference);
    const scoreColor = computed(() => {
      if (props.overallLevel === 'high') return '#ef4444';
      if (props.overallLevel === 'medium') return '#f59e0b';
      return '#22c55e';
    });
    const scoreTextClass = computed(() => {
      if (props.overallLevel === 'high') return 'text-red-600';
      if (props.overallLevel === 'medium') return 'text-amber-600';
      return 'text-green-600';
    });
    const levelClass = computed(() => {
      if (props.overallLevel === 'high') return 'bg-red-100 text-red-700 border-red-300';
      if (props.overallLevel === 'medium') return 'bg-amber-100 text-amber-700 border-amber-300';
      return 'bg-green-100 text-green-700 border-green-300';
    });
    const totalItems = computed(() => Object.values(props.severityDist).reduce((a, b) => a + b, 0));
    const highPct = computed(() => totalItems.value > 0 ? (props.severityDist['高'] || 0) / totalItems.value * 100 : 0);
    const midPct = computed(() => totalItems.value > 0 ? (props.severityDist['中'] || 0) / totalItems.value * 100 : 0);
    const lowPct = computed(() => totalItems.value > 0 ? (props.severityDist['低'] || 0) / totalItems.value * 100 : 0);

    const categoryCards = computed(() => [
      { key: 'dispute_points', label: '风险点', count: props.stats?.totalDisputes || 0, tab: 'summary' },
      { key: 'missing_clauses', label: '缺失条款', count: props.stats?.totalMissing || 0, tab: 'summary' },
      { key: 'modification_suggestions', label: '修改建议', count: props.stats?.totalSuggestions || 0, tab: 'suggestions' },
      { key: 'breach_cost_analysis', label: '违约场景', count: props.stats?.totalBreach || 0, tab: 'summary' },
      { key: 'party_review', label: '主体审查', count: props.stats?.totalParty || 0, tab: 'summary' },
    ]);

    return { circumference, scoreOffset, scoreColor, scoreTextClass, levelClass, totalItems, highPct, midPct, lowPct, categoryCards };
  },
};
</script>

<style scoped>
.risk-dashboard {
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
