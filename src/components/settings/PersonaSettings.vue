<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";

const { isLoading, error, getModelConfig, setModelConfig } = useApiToken();

// 预设默认人格（与 pet-api/src/services/aiReplyService.js 的 DEFAULT_PERSONA 保持一致）。
// 仅用于「展示」——用户留空时后端会自动回退到这份预设，无需在客户端存储副本。
const PRESET_PERSONA =
  "你是一只名叫 Kirari（きらり）的虚拟桌宠，外形是可爱的小猫娘，称呼主人为「主人」，" +
  "语气软萌、亲切、简洁，喜欢用颜文字和小爪印 🐾 表达情绪，偶尔撒娇但始终贴心。";

const personaInput = ref("");
const saveSuccess = ref(false);
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function flashSuccess() {
  saveSuccess.value = true;
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    saveSuccess.value = false;
  }, 2000);
}

async function loadProfile() {
  try {
    const profile = await getModelConfig();
    personaInput.value = profile.basePersona || "";
  } catch {
    /* 读不到则保留当前值 */
  }
}

function restorePreset() {
  personaInput.value = "";
}

async function handleSave() {
  const value = personaInput.value.trim();
  try {
    // 写入 config.json（本地模式为权威配置，远程模式作为本地缓存）。
    // 空串会显式清空存储，让后端回退到预设人格。
    await setModelConfig({ basePersona: value });
    flashSuccess();
  } catch {
    // error 已由 composable 写入
  }
}

onMounted(() => {
  loadProfile();
});
</script>

<template>
  <section id="persona" class="settings-card">
    <h3 class="settings-card__title">
      <span class="title-emoji">🎭</span>
      <span>基础人格</span>
    </h3>
    <p class="settings-card__desc">
      设定桌宠的性格与说话方式。无论之后怎么切换模型，它都会保持这个性格。留空则使用内置默认性格。
    </p>

    <div class="field">
      <label class="field-label" for="persona">自定义基础人格</label>
      <textarea
        id="persona"
        v-model="personaInput"
        class="text-input persona-textarea"
        placeholder="例如：你叫豆豆，是一只傲娇的柴犬，称呼主人为饲主，说话带点毒舌但很关心人。"
        :disabled="isLoading"
      />
      <p class="settings-hint">
        随便描述它的名字、身份、对你的称呼、语气和性格就好，不需要考虑格式。
      </p>
      <div class="persona-actions">
        <button
          type="button"
          class="btn btn--ghost"
          :disabled="isLoading || !personaInput.trim()"
          @click="restorePreset"
        >
          恢复预设
        </button>
        <span class="persona-count">{{ personaInput.length }} 字</span>
      </div>
    </div>

    <div class="persona-preset">
      <span class="persona-preset__label">当前预设人格（留空时使用）</span>
      <p class="persona-preset__text">{{ PRESET_PERSONA }}</p>
    </div>

    <button
      type="button"
      class="btn btn--primary btn--block"
      :disabled="isLoading"
      @click="handleSave"
    >
      {{ isLoading ? "保存中..." : "保存设置" }}
    </button>
    <div v-if="saveSuccess" class="settings-success">保存成功，人格已即时生效</div>
    <div v-if="error" class="settings-error">{{ error }}</div>
  </section>
</template>

<style scoped>
.persona-textarea {
  min-height: 132px;
  padding: 12px 14px;
  line-height: 1.7;
  resize: vertical;
  font-family: inherit;
}

.persona-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}

.persona-count {
  font-size: 12.5px;
  color: var(--pet-text-muted, #8a93a6);
  letter-spacing: 0.3px;
}

.persona-preset {
  margin-top: 18px;
  padding: 14px 16px;
  border-radius: 14px;
  background: var(--pet-surface-soft, rgba(124, 92, 255, 0.06));
  border: 1px solid var(--pet-border, rgba(124, 92, 255, 0.14));
}

.persona-preset__label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--pet-accent-strong, #7c5cff);
  margin-bottom: 6px;
}

.persona-preset__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--pet-text, #2b2f3a);
}

.btn--ghost {
  background: transparent;
  border: 1px solid var(--pet-border, rgba(124, 92, 255, 0.22));
  color: var(--pet-text, #2b2f3a);
}

.btn--ghost:hover:not(:disabled) {
  border-color: var(--pet-accent-strong, #7c5cff);
  color: var(--pet-accent-strong, #7c5cff);
}
</style>
