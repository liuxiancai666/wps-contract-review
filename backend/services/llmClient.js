const { OpenAI } = require('openai');

let llmClient;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Circuit Breaker 熔断器
const circuitBreaker = {
  state: 'closed',         // closed | open | half-open
  failures: 0,
  threshold: 3,            // 连续失败次数阈值
  resetAfter: 30000,       // 熔断持续时间(ms)
  lastFailure: 0,
  isOpen() {
    if (this.state === 'open' && Date.now() - this.lastFailure >= this.resetAfter) {
      this.state = 'half-open';
      console.warn('[LLM CircuitBreaker] Half-open: allowing one probe request.');
    }
    if (this.state === 'open') return true;
    return false;
  },
  recordSuccess() {
    this.state = 'closed';
    this.failures = 0;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
      console.warn(`[LLM CircuitBreaker] OPEN after ${this.failures} failures. Blocking requests for ${this.resetAfter}ms.`);
    }
  },
};

const getRequiredEnv = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for OpenAI-compatible LLM calls.`);
    return value;
};

const getLlmClient = () => {
    if (!llmClient) {
        llmClient = new OpenAI({
            apiKey: getRequiredEnv('LLM_API_KEY'),
            baseURL: getRequiredEnv('LLM_BASE_URL'),
        });
    }
    return llmClient;
};

const isRetryableError = (error) => {
    const status = error?.status || error?.response?.status;
    if (!status) return true;
    return status === 408 || status === 409 || status === 429 || status >= 500;
};

const normalizeLlmContent = (msg) => {
    // DeepSeek-V4-Flash 有时将回答放在 reasoning 而非 content 字段
    return msg?.content || msg?.reasoning || '';
};

const createChatCompletion = async (options, requestOptions = {}) => {
    // 熔断检查：如果断路器打开，立即抛出明确错误
    if (circuitBreaker.isOpen()) {
      const err = new Error('LLM 熔断器已打开（连续错误过多），请求已拦截。');
      err.code = 'CIRCUIT_OPEN';
      throw err;
    }

    const maxRetries = Number(process.env.LLM_MAX_RETRIES || 2);
    const baseDelay = Number(process.env.LLM_RETRY_BASE_MS || 800);
    const timeout = Number(process.env.LLM_TIMEOUT_MS || 90000);
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            const response = await getLlmClient().chat.completions.create({
                model: getRequiredEnv('LLM_MODEL'),
                ...options,
            }, {
                timeout,
                ...requestOptions,
            });

            // 成功：记录熔断成功
            circuitBreaker.recordSuccess();

            // 如果是流式响应，直接返回（调用方逐块处理）
            if (options.stream) return response;

            // 非流式：标准化 content 字段（处理 reasoning fallback）
            if (response?.choices?.[0]?.message) {
                response.choices[0].message.content = normalizeLlmContent(response.choices[0].message);
            }
            return response;
        } catch (error) {
            lastError = error;
            circuitBreaker.recordFailure();
            if (attempt >= maxRetries || !isRetryableError(error)) break;
            const delay = baseDelay * (2 ** attempt) + Math.floor(Math.random() * 250);
            console.warn(`[LLM] Chat completion failed; retrying in ${delay}ms (${attempt + 1}/${maxRetries}).`, error.message);
            await sleep(delay);
        }
    }

    throw lastError;
};

module.exports = {
    createChatCompletion,
};
