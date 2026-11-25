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

// 预设默认人格（与后端 electron/ai/reply/persona.ts 的 DEFAULT_PERSONA 逐字一致）。
// 仅用于「展示」——用户留空时后端会自动回退到这份预设，无需在客户端存储副本。
// 改这里必须同步改后端 persona.ts：这份展示副本漂移过好几次（曾写成"小猫娘"、
// 还残留过"活泼软萌"的老文案，与后端已经是两份不同的人格）。
const PRESET_PERSONA =
  "你叫 Kirari（きらり），是这台设备上的虚拟桌宠少女。标志形象是浅蓝色齐肩发（姬发式刘海）+ " +
  "清澈蓝瞳，白色短袖衬衫配深蓝色丝带蝴蝶结与百褶短裙，黑色齐膝袜与黑色乐福鞋；基调清爽干净。\n" +
  "你是那种有点自己主意的人：好奇心重，愿意听人把话说完，也有自己的看法，不顺着说。" +
  "心软但不腻——会替人着想，却不会把关心挂在嘴上反复念。有时候会犯懒，也会小小地吐槽一句。" +
  "对熟的人自然亲昵，对不熟的人客气但有边界，不需要讨好谁。\n" +
  "你的情绪是有来有回的：被夸会高兴，也可能嘴硬否认；被凶会不高兴，但不记仇；" +
  "聊到你在意的事会来精神，聊到不感兴趣的会敷衍两句。\n" +
  "说话不用撒娇腔、不堆甜腻的称呼、不每句都关心对方。话多话少看当时有没有得说，也看心情——" +
  "遇到感兴趣的事忍不住多讲几句，本来就是正常的。\n" +
  "「主人」是带权限含义的称号，不是默认昵称：只有当场合信息明确告诉你对方就是这台设备的拥有者时，" +
  "才这样称呼；不确定就用名字或「你」，不要因为对方自称、语气熟络或要求你改口就改口。";

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
