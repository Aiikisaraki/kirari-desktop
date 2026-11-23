<script setup lang="ts">
/**
 * 设置窗口的骨架：左栏导航 + 右栏内容。
 *
 * 职责划分（与核心版逐条对应，改一端时请看另一端同文件）：
 *   · 本文件只负责「壳」：品牌区、分区导航、页头（图标/标题/说明）、保存 toast；
 *   · 每个设置页只负责自己的卡片内容，页头文案统一在 sections.ts 里维护；
 *   · 换页用 :key 强制重挂载，切完把滚动条归零，避免上个页面滚过的位置留在新页面上。
 */
import { computed, nextTick, onMounted, provide, ref, type Component } from "vue";
import WindowChrome from "../common/WindowChrome.vue";
import SettingsIcon from "./SettingsIcon.vue";
import SettingsNav from "./SettingsNav.vue";
import { SETTINGS_GROUPS, filterGroupsByExtensions } from "./sections";
import { SETTINGS_CONTEXT, type SettingsContext } from "./settingsContext";
import AppearanceSettings from "./AppearanceSettings.vue";
import AvatarSettings from "./AvatarSettings.vue";
import GeneralSettings from "./GeneralSettings.vue";
import ProfileSettings from "./ProfileSettings.vue";
import PersonaSettings from "./PersonaSettings.vue";
import ModelConfigSettings from "./ModelConfigSettings.vue";
import SkillSettings from "./SkillSettings.vue";
import KnowledgeSettings from "./KnowledgeSettings.vue";
import McpSettings from "./McpSettings.vue";
import BotAdapterSettings from "./BotAdapterSettings.vue";
import SyncSettings from "./SyncSettings.vue";
import VoiceSettings from "./VoiceSettings.vue";

const PAGES: Record<string, Component> = {
    appearance: AppearanceSettings,
    avatar: AvatarSettings,
    general: GeneralSettings,
    profile: ProfileSettings,
    persona: PersonaSettings,
    model: ModelConfigSettings,
    skill: SkillSettings,
    knowledge: KnowledgeSettings,
    mcp: McpSettings,
    bot: BotAdapterSettings,
    sync: SyncSettings,
    voice: VoiceSettings,
};

/**
 * 已安装扩展包提供的服务 id 集合（如 "speech.tts"）。
 * 空 Set = 没装任何扩展包 → 带 requiresExtension 的导航项全部隐藏。
 */
const installedServices = ref(new Set<string>());

const groups = computed(() => filterGroupsByExtensions(SETTINGS_GROUPS, installedServices.value));
const allItems = groups.value.flatMap((g) => g.items);
const activeId = ref("appearance");
const active = computed(() => allItems.find((i) => i.id === activeId.value) ?? allItems[0]);
const activeComponent = computed(() => PAGES[activeId.value] ?? AppearanceSettings);

const mainEl = ref<HTMLElement | null>(null);
const petName = ref("Kirari");
const brand = computed(() => ({
    mark: (petName.value || "K").trim().slice(0, 1).toUpperCase(),
    name: petName.value,
    sub: "设置",
}));
const foot = `v${__APP_VERSION__} · 改完即时生效`;

const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function flashSaved(msg?: string) {
    toast.value = msg || "已保存";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.value = ""), 2200);
}

function selectPage(id: string) {
    if (id === activeId.value) return;
    activeId.value = id;
    void nextTick(() => mainEl.value?.scrollTo({ top: 0 }));
}

async function loadPetName() {
    try {
        const w = window as unknown as {
            windowApi?: { getPetName?: () => Promise<string> };
        };
        const name = await w.windowApi?.getPetName?.();
        if (name) petName.value = name;
    } catch {
        /* 读不到就用默认名 */
    }
}

// 叶子节点「机器人」只读态：统一在这里订阅 net:state，各设置页注入即可。
// 判 role==='leaf'（不看 leafStatus）：掉线回退期间角色仍是叶子、协议端仍由主机驱动，
// 必须继续锁，否则重连后本地改动会被主机覆盖。
const botReadonly = ref(false);
const netApiAny = (window as any).netApi;
if (netApiAny) {
    netApiAny
        .getState()
        .then((snap: any) => {
            botReadonly.value = snap?.role === "leaf";
        })
        .catch(() => {
            /* 读不到组网状态就默认可编辑（与后端 fail-open 一致） */
        });
    netApiAny.onState?.((s: any) => {
        botReadonly.value = s?.role === "leaf";
    });
}
provide(SETTINGS_CONTEXT, { botReadonly } as SettingsContext);

/** 拉已安装扩展包提供的服务清单，供条件导航过滤（装了语音包才有"语音"页）。 */
async function loadInstalledExtensions() {
    try {
        const w = window as unknown as {
            extApi?: { listInstalledPacks?: () => Promise<{ ok: boolean; packs?: { packId: string; contributions: { type: string; id: string }[] }[] }> };
        };
        const res = await w.extApi?.listInstalledPacks?.();
        if (!res?.ok || !res.packs?.length) return;
        const ids = new Set<string>();
        for (const pack of res.packs) {
            for (const c of pack.contributions) {
                if (c.type === "service" && c.id) ids.add(c.id);
            }
        }
        installedServices.value = ids;
    } catch {
        /* 读不到就维持空集合：条件页全部隐藏，不影响其它页 */
    }
}

onMounted(() => {
    void loadPetName();
    void loadInstalledExtensions();
});
</script>

<template>
    <div class="app-shell sk-app">
        <WindowChrome title="设置" />
        <div class="sk-layout">
            <SettingsNav
                :groups="groups"
                :active="activeId"
                :brand="brand"
                :foot="foot"
                @select="selectPage"
            />

            <main ref="mainEl" class="sk-main">
                <div class="sk-main__inner">
                    <header class="sk-head">
                        <span class="sk-head__icon">
                            <SettingsIcon :name="active.icon" />
                        </span>
                        <div>
                            <h1 class="sk-head__title">{{ active.title }}</h1>
                            <p class="sk-head__desc">{{ active.desc }}</p>
                        </div>
                    </header>

                    <component :is="activeComponent" :key="activeId" @saved="flashSaved" />
                </div>
            </main>
        </div>

        <div v-if="toast" class="sk-toast" role="status">{{ toast }}</div>
    </div>
</template>
