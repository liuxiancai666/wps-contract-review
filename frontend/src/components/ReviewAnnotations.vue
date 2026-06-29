<template>
  <div class="review-annotations inline-flex items-center gap-1">
    <el-tooltip content="同意此判断" placement="top">
      <button @click.stop="vote('agree')"
        :class="['p-1 rounded transition-colors', myVote === 'agree' ? 'bg-green-100 text-green-600' : 'text-gray-400 hover:text-green-500 hover:bg-green-50']"
        :title="`已同意: ${summary.agree}`">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
        </svg>
      </button>
    </el-tooltip>
    <span v-if="summary.agree > 0" class="text-xs text-green-500 min-w-[12px]">{{ summary.agree }}</span>

    <el-tooltip content="不同意此判断" placement="top">
      <button @click.stop="vote('disagree')"
        :class="['p-1 rounded transition-colors', myVote === 'disagree' ? 'bg-red-100 text-red-600' : 'text-gray-400 hover:text-red-500 hover:bg-red-50']"
        :title="`已不同意: ${summary.disagree}`">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
        </svg>
      </button>
    </el-tooltip>
    <span v-if="summary.disagree > 0" class="text-xs text-red-500 min-w-[12px]">{{ summary.disagree }}</span>

    <el-tooltip content="添加文字批注" placement="top">
      <button @click.stop="showCommentInput = !showCommentInput"
        :class="['p-1 rounded transition-colors', hasComments ? 'text-blue-500 bg-blue-50' : 'text-gray-400 hover:text-blue-500']"
        :title="`批注: ${summary.comment}`">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M18 5v8a2 2 0 01-2 2h-5l-5 4v-4H4a2 2 0 01-2-2V5a2 2 0 012-2h12a2 2 0 012 2zM7 8H5v2h2V8zm2 0h2v2H9V8zm6 0h-2v2h2V8z" clip-rule="evenodd"/>
        </svg>
      </button>
    </el-tooltip>
    <span v-if="summary.comment > 0" class="text-xs text-blue-500 min-w-[12px]">{{ summary.comment }}</span>

    <!-- 文字批注输入 -->
    <div v-if="showCommentInput" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30" @click.self="showCommentInput = false">
      <div class="bg-white rounded-lg shadow-xl p-4 w-96 max-w-full mx-4" @click.stop>
        <p class="text-sm font-medium text-text-dark mb-2">添加批注</p>
        <el-input
          v-model="commentText"
          type="textarea"
          :rows="3"
          placeholder="输入您的批注意见…"
          maxlength="500"
          show-word-limit
        />
        <div class="mt-3 flex justify-end gap-2">
          <button @click="showCommentInput = false" class="px-3 py-1.5 text-xs text-text-light border border-border-color rounded hover:bg-gray-50">取消</button>
          <button @click="submitComment" :disabled="!commentText.trim()" class="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark disabled:opacity-50">
            提交批注
          </button>
        </div>
      </div>
    </div>

    <!-- 查看已有批注列表 -->
    <el-tooltip v-if="hasComments" content="查看批注详情" placement="top">
      <button @click.stop="showCommentsList = !showCommentsList" class="p-1 text-blue-500 hover:text-blue-700">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/>
          <path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd"/>
        </svg>
      </button>
    </el-tooltip>

    <!-- 批注列表弹出 -->
    <div v-if="showCommentsList" class="fixed inset-0 z-50 flex items-center justify-center bg-black/30" @click.self="showCommentsList = false">
      <div class="bg-white rounded-lg shadow-xl p-4 w-96 max-w-full mx-4 max-h-80 overflow-y-auto" @click.stop>
        <div class="flex justify-between items-center mb-3">
          <p class="text-sm font-medium text-text-dark">批注列表 ({{ comments.length }})</p>
          <button @click="showCommentsList = false" class="text-gray-400 hover:text-gray-600">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/>
            </svg>
          </button>
        </div>
        <div v-if="comments.length === 0" class="text-center text-text-light py-6 text-xs">暂无批注</div>
        <div v-for="c in comments" :key="c.id" class="p-3 bg-bg-subtle rounded mb-2 text-xs">
          <div class="flex items-center gap-2 mb-1">
            <span :class="c.action_type === 'agree' ? 'text-green-600 bg-green-50' : c.action_type === 'disagree' ? 'text-red-600 bg-red-50' : 'text-blue-600 bg-blue-50'"
              class="px-1.5 py-0.5 rounded font-medium">
              {{ c.action_type === 'agree' ? '✓ 同意' : c.action_type === 'disagree' ? '✗ 不同意' : '💬 批注' }}
            </span>
            <span class="text-text-light">{{ formatTime(c.created_at) }}</span>
          </div>
          <p v-if="c.comment_text" class="text-text-main mt-1">{{ c.comment_text }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed } from 'vue';

export default {
  name: 'ReviewAnnotations',
  props: {
    contractId: { type: [Number, String], required: true },
    itemType: { type: String, required: true },
    itemIndex: { type: Number, required: true },
    comments: { type: Array, default: () => [] },
    summary: {
      type: Object,
      default: () => ({ agree: 0, disagree: 0, comment: 0, resolved: false }),
    },
  },
  emits: ['add-comment', 'refresh'],
  setup(props, { emit }) {
    const showCommentInput = ref(false);
    const showCommentsList = ref(false);
    const commentText = ref('');

    const hasComments = computed(() => props.comments.length > 0);

    const myVote = computed(() => {
      // 简化为：看是否有自己同类型的投票
      return null;
    });

    const vote = (actionType) => {
      emit('add-comment', {
        item_type: props.itemType,
        item_index: props.itemIndex,
        action_type: actionType,
        comment_text: null,
      });
    };

    const submitComment = () => {
      if (!commentText.value.trim()) return;
      emit('add-comment', {
        item_type: props.itemType,
        item_index: props.itemIndex,
        action_type: 'comment',
        comment_text: commentText.value.trim(),
      });
      commentText.value = '';
      showCommentInput.value = false;
    };

    const formatTime = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    };

    return { showCommentInput, showCommentsList, commentText, hasComments, myVote, vote, submitComment, formatTime };
  },
};
</script>
