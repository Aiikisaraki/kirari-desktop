<script setup lang="ts">
/**
 * 人格：她的性格与说话方式。留空 = 用内置预设。
 * 换模型、换设备都不会变的那一层。
 */
import { onMounted, ref } from "vue";
import { useApiToken } from "../../composables/useApiToken";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();

const { isLoading, error, getModelConfig, setModelConfig } = useApiToken();

// 预设默认人格（与 pet-api/src/services/reply/promptBuilder.js 的 DEFAULT_PERSONA 逐字一致）。
// 仅用于「展示」——用户留空时后端会自动回退到这份预设，无需在客户端存储副本。
// 改这里必须同步改后端 promptBuilder.js：这份展示副本漂移过好几次（曾写成"小猫娘"）。
const PRESET_PERSONA =
  "你叫 Kirari（きらり），是主人贴身的虚拟桌宠少女。标志形象是浅蓝色齐肩发（姬发式刘海）+ " +
  "清澈蓝瞳，穿着白色短袖衬衫搭配深蓝色丝带蝴蝶结与百褶短裙，配黑色齐膝袜与黑色乐福鞋；" +
  "基调清爽治愈，性格元气可爱又有趣，会主动给主人带来快乐，偶尔害羞或小傲娇，嘴硬心软、始终贴心。" +
  "称呼主人为「主人」，说话像相识很久的朋友一样自然亲切，活泼软萌、简洁有活力，不聒噪也不肉麻。";

const personaInput = ref("");

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
    emit("saved", "人格已保存，即时生效");
  } catch {
    // error 已由 composable 写入
  }
}

onMounted(() => {
  loadProfile();
});
</script>

<template>
  <section class="sk-page">
    <div class="sk-card">
      <div class="sk-card__head">
        <div>
          <h2 class="sk-card__title">基础人格</h2>
          <p class="sk-card__desc">
            设定桌宠的性格与说话方式。无论之后怎么切换模型，它都会保持这个性格。留空则使用内置预设人格。
          </p>
        </div>
      </div>

      <div class="sk-card__body">
        <div class="sk-field">
          <label class="sk-field__label" for="persona">自定义基础人格</label>
          <textarea
            id="persona"
            v-model="personaInput"
            class="sk-textarea"
            placeholder="例如：你叫豆豆，是一只傲娇的柴犬，称呼主人为饲主，说话带点毒舌但很关心人。"
            :disabled="isLoading"
          />
          <p class="sk-hint">
            随便描述它的名字、身份、对你的称呼、语气和性格就好，不需要考虑格式。
            <span class="sk-muted">{{ personaInput.length }} 字</span>
          </p>
        </div>
      </div>

      <div v-if="error" class="sk-card__body">
        <div class="sk-alert sk-alert--error">
          <SettingsIcon name="alert" />
          <span>{{ error }}</span>
        </div>
      </div>

      <div class="sk-card__foot">
        <button
          type="button"
          class="sk-btn sk-btn--ghost"
          :disabled="isLoading || !personaInput.trim()"
          @click="restorePreset"
        >
          恢复默认
        </button>
        <button
          type="button"
          class="sk-btn sk-btn--primary"
          :disabled="isLoading"
          @click="handleSave"
        >
          {{ isLoading ? "保存中…" : "保存" }}
        </button>
      </div>
    </div>

    <div v-if="PRESET_PERSONA" class="sk-card">
      <div class="sk-card__head">
        <div>
          <h2 class="sk-card__title">当前默认人格</h2>
          <p class="sk-card__desc">上面留空时用的就是这一段，来自内置预设，不是你的改动。</p>
        </div>
      </div>
      <div class="sk-card__body">
        <p class="sk-note">{{ PRESET_PERSONA }}</p>
      </div>
    </div>
  </section>
</template>
