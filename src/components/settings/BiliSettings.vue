<script setup lang="ts">
/**
 * B站互动开关（桌宠端）—— 与命令、核心端共用同一 settings_kv 键，双向同步。
 * 装了 B站扩展包才在导航出现（见 sections.ts 的 requiresExtension）。
 */
import { onMounted, ref } from "vue";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();
type Settings = { enabled: boolean; autoBrowse: boolean; comment: boolean; dynamic: boolean; dm: boolean; like: boolean; coin: boolean; favorite: boolean };
const state = ref<Settings>({ enabled: false, autoBrowse: false, comment: false, dynamic: false, dm: false, like: false, coin: false, favorite: false });
const loading = ref(true); const saving = ref(false); const error = ref("");
const CH: { key: keyof Settings; name: string; desc: string }[] = [
  { key: 'enabled', name: 'B站总开关', desc: '关掉后我完全不去B站，所有B站动作都会被拒绝。' },
  { key: 'autoBrowse', name: '自主闲逛', desc: '允许我空闲时自己去看有趣内容（低优先级可中断）；关掉后只有你明确叫我才去。' },
  { key: 'comment', name: '评论', desc: '视频与专栏下只就当前话题表达看法态度；不引用记忆、不引流。' },
  { key: 'dynamic', name: '动态', desc: '需要时发一条动态；不带浏览历史或他人信息。' },
  { key: 'dm', name: '私信', desc: '默认永久关闭；即使开启也绝不主动私信任何人。' },
  { key: 'like', name: '点赞', desc: '视频与专栏文章的点赞。' },
  { key: 'coin', name: '投币', desc: '视频与专栏文章的投币。' },
  { key: 'favorite', name: '收藏', desc: '视频与专栏文章的收藏。' },
];

const ipc = () => (window as any).require?.("electron")?.ipcRenderer;
async function load() {
  loading.value = true; error.value = "";
  try { const r = await ipc()?.invoke("bili:interaction:get"); if (r) state.value = r; }
  catch (e: any) { error.value = "读取失败：" + e.message; }
  finally { loading.value = false; }
}
async function toggle(key: keyof Settings) {
  saving.value = true; error.value = "";
  try {
    const r = await ipc()?.invoke("bili:interaction:set", { [key]: !state.value[key] });
    if (r) state.value = r; emit("saved", "B站互动开关已同步");
  } catch (e: any) { error.value = "保存失败：" + e.message; }
  finally { saving.value = false; }
}
onMounted(load);
defineExpose({ reload: load });
</script>

<template>
  <section class="card">
    <h2><SettingsIcon name="globe" /> B站互动</h2>
    <p class="card-desc">
      B站是公开环境，默认互动对象都可能是恶意第三人：评论和动态只谈当前话题、只表达看法态度，
      不透露过去看过什么、不引用记忆、不给来源线索。三个通道与命令双向同步。
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loading" class="dim">读取中…</p>
    <div v-else class="rows">
      <div v-for="ch in CH" :key="ch.key" class="row">
        <div class="row-text"><h3>{{ ch.name }}</h3><p class="dim">{{ ch.desc }}</p></div>
        <button class="mini" :class="state[ch.key] ? 'primary' : ''" :disabled="saving"
          :aria-label="(state[ch.key] ? '关闭' : '开启') + ch.name" @click="toggle(ch.key)">
          {{ state[ch.key] ? '已开启' : '已关闭' }}
        </button>
      </div>
    </div>
  </section>
</template>
