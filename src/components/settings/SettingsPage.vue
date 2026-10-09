<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref } from "vue";
import WindowChrome from "../common/WindowChrome.vue";
import SettingsNav from "./SettingsNav.vue";
import AppearanceSettings from "./AppearanceSettings.vue";
import GeneralSettings from "./GeneralSettings.vue";
import AvatarSettings from "./AvatarSettings.vue";
import PersonaSettings from "./PersonaSettings.vue";
import ModelConfigSettings from "./ModelConfigSettings.vue";
import BotAdapterSettings from "./BotAdapterSettings.vue";
import McpSettings from "./McpSettings.vue";
import SkillSettings from "./SkillSettings.vue";
import KnowledgeSettings from "./KnowledgeSettings.vue";
import ProfileSettings from "./ProfileSettings.vue";
import { SETTINGS_CONTEXT, type SettingsContext } from "./settingsContext";

const error = ref("");
const petName = ref("Kirari");
const activeId = ref<string>("appearance");

/**
 * 当前激活的区块组件。
 * 标签页式切换：只渲染被选中的那张卡，其他 7 张不挂载、不占渲染预算。
 * 这样既符合「一个标签页只显示一类」的工整感，也避免了多卡片堆叠时
 * 「每张都只剩一行」的尴尬空旷感。
 */
const activeComponent = computed(() => {
    switch (activeId.value) {
        case "appearance":
            return AppearanceSettings;
        case "general":
            return GeneralSettings;
        case "avatar":
            return AvatarSettings;
        case "persona":
            return PersonaSettings;
        case "profile":
            return ProfileSettings;
        case "model":
            return ModelConfigSettings;
        case "mcp":
            return McpSettings;
        case "skill":
            return SkillSettings;
        case "knowledge":
            return KnowledgeSettings;
        case "bot":
            return BotAdapterSettings;
        default:
            return AppearanceSettings;
    }
});

const activeMeta = computed(() =>
    sections.value.find((s) => s.id === activeId.value) ?? sections.value[0],
);

// ─────────────────────────────────────────────────────────────────────
// 响应式：窄窗口（≤ 640px）切到顶部胶囊，宽窗口切到左侧侧栏。
// 用 matchMedia 监听断点变化，整页结构由 CSS 完成，这里只是查询。
// 阈值从 720 调到 640：Electron 设置窗口 minWidth 也设为 640，
// 让真正接近手机宽度的窗口才走移动端布局，正常桌面窗口始终走双栏。
// ─────────────────────────────────────────────────────────────────────
const isNarrow = ref(
    typeof window !== "undefined"
        ? window.matchMedia("(max-width: 640px)").matches
        : false,
);
let mq: MediaQueryList | null = null;
function handleMqChange(e: MediaQueryListEvent) {
    isNarrow.value = e.matches;
}

function setActiveId(id: string) {
    activeId.value = id;
    // 切 tab 时把整页滚动容器归零。否则上个 tab（如模型、技能、MCP）
    // 滚到的 scrollTop 会保留下来，新 tab 的卡片标题可能被滚到视口上方看不见，
    // 底部内容（密码框、提交按钮等）被顶到视口下方。nextTick 后再归零，
    // 让 :key 触发的旧组件卸载 + 新组件挂载先完成，避免 reflow 中途触发 scroll。
    void nextTick(() => {
        const root = document.querySelector(".settings-root") as HTMLElement | null;
        if (root) root.scrollTop = 0;
    });
}

async function loadPetName() {
    try {
        const w = window as unknown as {
            windowApi?: { getPetName?: () => Promise<string> };
        };
        if (w.windowApi?.getPetName) {
            const name = await w.windowApi.getPetName();
            if (name) petName.value = name;
        }
    } catch {
        /* 保留默认 */
    }
}

// 桌宠本机运行、不设账户：设置上下文不再携带模式与鉴权状态。
const ctx: SettingsContext = {};
provide(SETTINGS_CONTEXT, ctx);

// 导航项。每个分区可附带 hint（侧栏下方副标题展示）、count（侧栏右侧小徽标）。
const sections = computed(() => {
    const list: {
        id: string;
        label: string;
        emoji: string;
        hint: string;
        count?: number | (() => number);
    }[] = [
        { id: "appearance", label: "外观", emoji: "🎨", hint: "主题与视觉风格" },
        { id: "general", label: "通用", emoji: "✨", hint: "备注名与开机自启" },
        { id: "avatar", label: "形象", emoji: "🐾", hint: "桌宠精灵" },
        { id: "profile", label: "个人", emoji: "👤", hint: "我的头像" },
        { id: "persona", label: "人格", emoji: "🎭", hint: "自定义基础人格" },
    ];
    list.push(
        { id: "model", label: "模型", emoji: "🧠", hint: "大模型与联网搜索" },
        { id: "mcp", label: "MCP", emoji: "🔌", hint: "MCP 服务器" },
        { id: "skill", label: "技能", emoji: "🧩", hint: "行为模板与工具" },
        { id: "knowledge", label: "知识库", emoji: "📚", hint: "私人知识库（每日补充）" },
        { id: "bot", label: "机器人", emoji: "🤖", hint: "QQ / OneBot 接入" },
    );
    return list;
});

const activeLabel = computed(() => {
    const m = activeMeta.value;
    return m ? `${m.emoji} ${m.label}` : "✨ 准备就绪";
});

onMounted(() => {
    loadPetName();
    if (typeof window !== "undefined") {
        mq = window.matchMedia("(max-width: 640px)");
        isNarrow.value = mq.matches;
        // Safari ≤ 13 use addListener; modern browsers use addEventListener
        if (mq.addEventListener) {
            mq.addEventListener("change", handleMqChange);
        } else {
            mq.addListener(handleMqChange as (e: MediaQueryListEvent) => void);
        }
    }
});
// 注意：本次页面通常是 BrowserWindow 实例，窗口关闭即销毁，无需专门 off。
</script>

<template>
    <div class="app-shell">
        <WindowChrome title="设置" />
        <div class="settings-root">
            <!--
              移动端：sticky 顶部全宽（问候条 + 胶囊导航），整页滚动时导航不丢。
              桌面端：问候条移到右侧 .settings-shell__main 顶部，侧栏独立从
              .settings-shell 顶部开始，避免「顶部全宽 + 侧栏 + 问候条重复」。
            -->
            <section v-if="isNarrow" class="settings-top settings-top--mobile" aria-label="设置概览">
                <header class="settings-greeting">
                    <span class="settings-greeting__avatar" aria-hidden="true">🐾</span>
                    <p class="settings-greeting__text">
                        <span class="settings-greeting__hi">Hi</span>
                        <span class="settings-greeting__name">{{ petName }}</span>
                        <span class="settings-greeting__sub">· {{ activeLabel }}</span>
                    </p>
                    <p v-if="error" class="settings-greeting__error">{{ error }}</p>
                    <span class="settings-greeting__spacer" />
                </header>
                <SettingsNav
                    mode="pills"
                    :sections="sections"
                    :active-id="activeId"
                    @update:active-id="setActiveId"
                />
            </section>

            <!-- 桌面端双栏布局：侧栏 + 右栏主区（圆角卡片） -->
            <div v-if="!isNarrow" class="settings-shell">
                <SettingsNav
                    mode="sidebar"
                    :sections="sections"
                    :active-id="activeId"
                    :greeting="`Hi ${petName} · ${activeLabel}`"
                    @update:active-id="setActiveId"
                />
                <div class="settings-shell__main">
                    <!--
                      通过 :key="activeId" 强制 Vue 卸载旧组件、挂载新组件。
                      不用 <Transition>：它的 mode="out-in" 在某些 CSS 冲突下
                      会让 leave 阶段的占位元素卡住不消失，导致右侧整片空白。
                      改用挂载后立即触发的 .from-fade CSS 动画，220ms 完成淡入，
                      视觉上是同样的切换感，但生命周期更可控。
                    -->
                    <component
                        :is="activeComponent"
                        :key="activeId"
                        class="settings-shell__card from-fade"
                    />
                </div>
            </div>

            <!-- 移动端：顶部胶囊 + 单卡片 -->
            <main v-else class="settings-main">
                <component
                    :is="activeComponent"
                    :key="activeId"
                    class="settings-main__card from-fade"
                />
            </main>
        </div>
    </div>
</template>
