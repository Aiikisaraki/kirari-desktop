<script setup lang="ts">
import { ref, computed } from "vue";
import { useAdapters, type AdapterConfigInput } from "../../composables/useAdapters";

const {
  adapters,
  add,
  update,
  remove,
  connect,
  disconnect,
  setOwner,
} = useAdapters();

// 新增表单
const showForm = ref(false);
const formType = ref<"onebot" | "qqofficial">("onebot");
const formName = ref("");
const formWsUrl = ref("");
const formToken = ref("");
const formAppId = ref("");
const formSecret = ref("");
const formError = ref("");

const isOneBot = computed(() => formType.value === "onebot");

async function handleAdd() {
  formError.value = "";
  const name = formName.value.trim();
  if (!name) {
    formError.value = "请填写适配器名称";
    return;
  }
  if (formType.value === "onebot") {
    if (!formWsUrl.value.trim()) {
      formError.value = "OneBot 需要填写 WS 地址";
      return;
    }
    const cfg: AdapterConfigInput = {
      type: "onebot",
      name,
      enabled: true,
      config: {
        wsUrl: formWsUrl.value.trim(),
        token: formToken.value.trim() || undefined,
        protocol: "onebot11",
      },
      ownerAccount: null,
    };
    await add(cfg);
  } else {
    // QQ 官方机器人：第二阶段实现，先登记配置占位
    const cfg: AdapterConfigInput = {
      type: "qqofficial",
      name,
      enabled: false,
      config: {
        appId: formAppId.value.trim(),
        clientSecret: formSecret.value.trim(),
      },
      ownerAccount: null,
    };
    await add(cfg);
  }
  // 重置表单
  formName.value = "";
  formWsUrl.value = "";
  formToken.value = "";
  formAppId.value = "";
  formSecret.value = "";
  showForm.value = false;
}

async function handleToggle(ad: any) {
  if (ad.connected) await disconnect(ad.id);
  else await connect(ad.id);
}

async function handleRemove(ad: any) {
  await remove(ad.id);
}

async function handleSetOwner(ad: any) {
  const key = (ad as any)._ownerKey || "";
  await setOwner(ad.id, key);
}

async function handleGroupMode(ad: any, val: string) {
  await update(ad.id, { config: { groupReplyMode: val } });
}

async function handleGroupFilter(ad: any, val: string) {
  await update(ad.id, { config: { groupFilter: val } });
}

async function handleGroupList(ad: any, field: "groupAllowlist" | "groupBlocklist", val: string) {
  const arr = val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  await update(ad.id, { config: { [field]: arr } });
}
</script>

<template>
  <section id="bot" class="settings-card">
    <h3 class="settings-card__title">
      <span class="title-emoji">🤖</span>
      <span>机器人适配器</span>
    </h3>
    <p class="settings-card__desc">
      接入 OneBot（NapCat / LLOneBot）或 QQ 官方机器人，让桌宠通过 QQ 收发消息。可同时挂多个适配器。
      把某个 QQ 号设为「主人」后，该账号与桌面宠共享同一份聊天记录与记忆。
    </p>

    <!-- 已配置适配器列表 -->
    <div v-if="adapters.length" class="adapter-list">
      <div v-for="ad in adapters" :key="ad.id" class="adapter-card">
        <div class="adapter-head">
          <div class="adapter-name">
            <span class="badge" :class="ad.type">{{ ad.type === 'onebot' ? 'OneBot' : 'QQ官方' }}</span>
            <strong>{{ ad.name }}</strong>
          </div>
          <span class="status-dot" :class="{ on: ad.connected, off: !ad.connected }">
            {{ ad.connected ? "已连接" : "未连接" }}
          </span>
        </div>

        <div v-if="ad.lastError" class="adapter-err">⚠ {{ ad.lastError }}</div>

        <div class="adapter-actions">
          <button type="button" class="btn btn--primary btn--sm" @click="handleToggle(ad)">
            {{ ad.connected ? "断开" : "连接" }}
          </button>
          <button type="button" class="btn btn--ghost btn--sm" @click="handleRemove(ad)">删除</button>
        </div>

        <!-- 群消息回复触发方式（仅 OneBot，默认关闭，最安全） -->
        <div v-if="ad.type === 'onebot'" class="group-row">
          <label class="field-label">群消息回复</label>
          <select
            class="settings-select"
            :value="(ad.config && ad.config.groupReplyMode) || 'off'"
            @change="handleGroupMode(ad, ($event.target as HTMLSelectElement).value)"
          >
            <option value="off">关闭（不回复群消息）</option>
            <option value="mention">仅当我被 @ 时回复</option>
            <option value="all">回复所有消息（危险）</option>
          </select>
        </div>

        <!-- 群范围过滤：白名单 / 黑名单 -->
        <template
          v-if="ad.type === 'onebot' && ad.config && ad.config.groupReplyMode && ad.config.groupReplyMode !== 'off'"
        >
          <div class="group-row">
            <label class="field-label">群范围</label>
            <select
              class="settings-select"
              :value="(ad.config && ad.config.groupFilter) || 'whitelist'"
              @change="handleGroupFilter(ad, ($event.target as HTMLSelectElement).value)"
            >
              <option value="whitelist">白名单（仅允许列表内的群可被回复）</option>
              <option value="blacklist">黑名单（排除列表内的群，其余均可回复）</option>
            </select>
          </div>

          <div v-if="(ad.config && ad.config.groupFilter) !== 'blacklist'" class="group-row">
            <label class="field-label">允许回复的群号</label>
            <input
              class="text-input"
              type="text"
              :value="((ad.config && (ad.config.groupAllowlist as unknown as string[])) || []).join(', ')"
              @change="handleGroupList(ad, 'groupAllowlist', ($event.target as HTMLInputElement).value)"
              placeholder="输入允许回复的群号，逗号分隔，如 123456789, 987654321"
            />
          </div>
          <div v-else class="group-row">
            <label class="field-label">排除回复的群号</label>
            <input
              class="text-input"
              type="text"
              :value="((ad.config && (ad.config.groupBlocklist as unknown as string[])) || []).join(', ')"
              @change="handleGroupList(ad, 'groupBlocklist', ($event.target as HTMLInputElement).value)"
              placeholder="输入永不回复的群号，逗号分隔，如 123456789（真实群聊建议列入此处）"
            />
          </div>
        </template>
        <p v-if="ad.type === 'onebot'" class="settings-hint settings-hint--warn">
          ⚠ 群消息默认关闭。开启后默认「白名单」模式——只有你显式加入允许列表的群才会被回复；选「黑名单」会回复除排除列表外的所有群，请谨慎。
        </p>

        <!-- 主人绑定 -->
        <div class="owner-row">
          <template v-if="ad.ownerAccount">
            <span class="owner-tag">主人：{{ ad.ownerAccount }}</span>
            <button type="button" class="btn btn--ghost btn--sm" @click="setOwner(ad.id, '')">
              取消主人
            </button>
          </template>
          <template v-else>
            <select v-model="(ad as any)._ownerKey" class="settings-select owner-select">
              <option value="">设为某账号为主人…</option>
              <option v-for="acc in ad.knownAccounts" :key="acc" :value="acc">
                {{ acc }}
              </option>
            </select>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              :disabled="!(ad as any)._ownerKey"
              @click="handleSetOwner(ad)"
            >
              设为主人
            </button>
          </template>
        </div>
        <p v-if="!ad.knownAccounts.length" class="settings-hint">
          连接后收到消息，才会出现可设为主人的账号。
        </p>
      </div>
    </div>

    <!-- 新增表单 -->
    <div v-if="showForm" class="adapter-form">
      <div class="field">
        <span class="field-label">协议类型</span>
        <div class="provider-row">
          <label class="provider-option">
            <input type="radio" value="onebot" v-model="formType" />
            <span>OneBot（NapCat / LLOneBot）</span>
          </label>
          <label class="provider-option">
            <input type="radio" value="qqofficial" v-model="formType" />
            <span>QQ 官方机器人（第二阶段）</span>
          </label>
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="ad-name">名称</label>
        <input id="ad-name" v-model="formName" class="text-input" type="text" placeholder="如：NapCat 主号" />
      </div>

      <template v-if="isOneBot">
        <div class="field">
          <label class="field-label" for="ad-ws">WS 地址</label>
          <input id="ad-ws" v-model="formWsUrl" class="text-input" type="text" placeholder="ws://127.0.0.1:3001" />
        </div>
        <div class="field">
          <label class="field-label" for="ad-token">访问令牌（可选）</label>
          <input id="ad-token" v-model="formToken" class="text-input" type="password" placeholder="对应 OneBot 的 access_token" />
        </div>
      </template>
      <template v-else>
        <div class="field">
          <label class="field-label" for="ad-appid">AppID</label>
          <input id="ad-appid" v-model="formAppId" class="text-input" type="text" placeholder="QQ 开放平台 AppID" />
        </div>
        <div class="field">
          <label class="field-label" for="ad-secret">Client Secret</label>
          <input id="ad-secret" v-model="formSecret" class="text-input" type="password" placeholder="QQ 开放平台密钥" />
        </div>
        <p class="settings-hint">QQ 官方机器人收发逻辑将在第二阶段接入，此处仅登记配置。</p>
      </template>

      <div v-if="formError" class="settings-error">{{ formError }}</div>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" @click="handleAdd">添加</button>
        <button type="button" class="btn btn--ghost" @click="showForm = false">取消</button>
      </div>
    </div>

    <button v-else type="button" class="btn btn--import btn--block adapter-add" @click="showForm = true">
      + 添加机器人适配器
    </button>
  </section>
</template>

<style scoped>
/* 基础样式：窄窗口（视口 < 860px）沿用原样，不做任何改动 */
.adapter-list {
    display: grid;
    gap: 12px;
}
.adapter-card {
    display: grid;
    gap: 10px;
    padding: 14px;
    border-radius: 14px;
    background: var(--pet-accent-soft);
    border: 1px dashed var(--pet-accent-strong-border);
}
/* 宽窗口（视口 ≥ 860px）：限宽 760 居中 + 加大内边距，与技能 / MCP 一致 */
@media (min-width: 860px) {
    .adapter-list {
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        gap: 14px;
    }
    .adapter-card {
        gap: 12px;
        padding: 18px 22px;
        border-radius: 16px;
    }
}
.adapter-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.adapter-name {
    display: flex;
    align-items: center;
    gap: 8px;
}
.badge {
    font-size: 11px;
    font-weight: 700;
    padding: 2px 9px;
    border-radius: 999px;
    color: #fff;
    letter-spacing: 0.3px;
}
.badge.onebot {
    background: linear-gradient(135deg, #34d399, #059669);
}
.badge.qqofficial {
    background: linear-gradient(135deg, #38bdf8, #2563eb);
}
.status-dot {
    font-size: 12px;
    font-weight: 700;
}
.status-dot.on {
    color: #16a34a;
}
.status-dot.off {
    color: var(--pet-muted);
}
.adapter-err {
    font-size: 12px;
    color: var(--pet-danger);
}
.adapter-actions {
    display: flex;
    gap: 8px;
}
.group-row {
    display: grid;
    gap: 6px;
}
.owner-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.owner-tag {
    font-size: 12px;
    font-weight: 700;
    color: #16a34a;
    background: rgba(22, 163, 74, 0.1);
    padding: 3px 8px;
    border-radius: 999px;
}
.owner-select {
    flex: 1;
    min-width: 140px;
}
/* 基础样式：窄窗口沿用原样 */
.adapter-form {
    display: grid;
    gap: 12px;
    padding: 14px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid var(--pet-border);
}
/* 添加按钮：基础态填满；宽窗口（≥ 860px）与 .adapter-list 同宽上限 760 居中 */
.btn.btn--import.btn--block.adapter-add {
    width: 100%;
    margin: 18px auto 0;
}
@media (min-width: 860px) {
    .adapter-form {
        gap: 14px;
        padding: 18px 22px;
        border-radius: 16px;
    }
    .btn.btn--import.btn--block.adapter-add {
        max-width: 760px;
    }
}
</style>
