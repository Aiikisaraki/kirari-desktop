<script setup lang="ts">
import { inject, ref, computed } from "vue";
import { useAdapters, type AdapterConfigInput } from "../../composables/useAdapters";
import { SETTINGS_CONTEXT, type SettingsContext } from "./settingsContext";
import SettingsIcon from "./SettingsIcon.vue";

const emit = defineEmits<{ saved: [msg?: string] }>();
const errorMsg = ref("");

// 叶子节点：协议端跟随主机（主机才是 QQ 连接出口），只读
const ctx = inject<SettingsContext | null>(SETTINGS_CONTEXT, null);
const botReadonly = ctx?.botReadonly;

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
const formType = ref<"onebot" | "qqofficial">("qqofficial");
const formName = ref("");
const formWsUrl = ref("");
const formToken = ref("");
const formAppId = ref("");
const formSecret = ref("");
const formError = ref("");

const isOneBot = computed(() => formType.value === "onebot");

async function handleAdd() {
  if (botReadonly?.value) return;
  formError.value = "";
  errorMsg.value = "";
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
    // QQ 官方机器人（官方 WS 反向连接）：默认启用，连上即可收消息
    const cfg: AdapterConfigInput = {
      type: "qqofficial",
      name,
      enabled: true,
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
  emit("saved", "机器人适配器已添加");
}

async function handleToggle(ad: any) {
  if (botReadonly?.value) return;
  try {
    if (ad.connected) await disconnect(ad.id);
    else await connect(ad.id);
    emit("saved", ad.connected ? "机器人已断开" : "正在连接机器人");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "连接操作失败";
  }
}

async function handleRemove(ad: any) {
  if (botReadonly?.value) return;
  try {
    await remove(ad.id);
    emit("saved", "机器人适配器已删除");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "删除失败";
  }
}

async function handleSetOwner(ad: any) {
  if (botReadonly?.value) return;
  const key = (ad as any)._ownerKey || "";
  try {
    await setOwner(ad.id, key);
    emit("saved", "主人账号已绑定");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "绑定失败";
  }
}

async function handleGroupMode(ad: any, val: string) {
  if (botReadonly?.value) return;
  try {
    await update(ad.id, { config: { groupReplyMode: val } });
    emit("saved", "群消息策略已更新");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "保存失败";
  }
}

async function handleGroupFilter(ad: any, val: string) {
  if (botReadonly?.value) return;
  try {
    await update(ad.id, { config: { groupFilter: val } });
    emit("saved", "群范围已更新");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "保存失败";
  }
}

async function handleGroupList(ad: any, field: "groupAllowlist" | "groupBlocklist", val: string) {
  if (botReadonly?.value) return;
  const arr = val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await update(ad.id, { config: { [field]: arr } });
    emit("saved", "群列表已更新");
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : "保存失败";
  }
}
</script>


<template>
  <section class="sk-page">
    <div v-if="botReadonly" class="sk-alert sk-alert--warn">
      <SettingsIcon name="alert" />
      <span>当前节点是组网叶子，QQ 连接由主机统一驱动，协议端跟随主机、这里只读。请到主机上操作，或先退出组网。</span>
    </div>

    <div class="sk-card">
      <div class="sk-card__head">
        <div>
          <h2 class="sk-card__title">机器人</h2>
          <p class="sk-card__desc">默认使用 QQ 官方机器人（官方 WebSocket 反向连接，合规稳定）。OneBot 作为通用协议端保留，用于非 QQ 的自有机器人框架。可同时挂多个适配器。把某个账号设为主人后，该账号与桌宠共享同一份聊天记录与记忆。</p>
        </div>
      </div>

      <p v-if="errorMsg" class="sk-alert sk-alert--error">
        <SettingsIcon name="alert" />
        <span>{{ errorMsg }}</span>
      </p>
      <fieldset class="sk-fieldset" :disabled="!!botReadonly">
        <p v-if="!adapters.length && !showForm" class="sk-empty">
          {{ botReadonly ? "机器人由主机统一接入，本机不单独配置。" : "还没有接入机器人。添加一个 QQ 官方机器人或 OneBot 适配器。" }}
        </p>

        <div v-if="adapters.length" class="sk-items">
          <article v-for="ad in adapters" :key="ad.id" class="sk-item">
            <div class="sk-item__main">
              <div class="sk-item__title">
                <strong>{{ ad.name }}</strong>
                <span class="sk-badge sk-badge--brand">{{ ad.type === 'onebot' ? 'OneBot' : 'QQ 官方' }}</span>
                <span class="sk-badge" :class="ad.connected ? 'sk-badge--ok' : 'sk-badge--warn'">
                  <span class="sk-dot" />{{ ad.connected ? "已连接" : "未连接" }}
                </span>
              </div>
              <p v-if="ad.type === 'qqofficial'" class="sk-item__meta">AppID {{ ad.config?.appId || "（未填）" }}</p>
              <p v-else class="sk-item__meta sk-item__meta--mono">{{ ad.config?.wsUrl || "（没填地址）" }}</p>
              <p v-if="ad.lastError" class="sk-hint sk-hint--warn">{{ ad.lastError }}</p>

              <div v-if="ad.type === 'onebot'" class="sk-editor">
                <div class="sk-field">
                  <label class="sk-field__label">群消息回复</label>
                  <select class="sk-select" :value="(ad.config && ad.config.groupReplyMode) || 'off'" @change="handleGroupMode(ad, ($event.target as HTMLSelectElement).value)">
                    <option value="off">关闭（不回复群消息）</option>
                    <option value="mention">仅当我被 @ 时回复</option>
                    <option value="all">回复所有消息（危险）</option>
                  </select>
                </div>
                <template v-if="ad.config && ad.config.groupReplyMode && ad.config.groupReplyMode !== 'off'">
                  <div class="sk-field">
                    <label class="sk-field__label">群范围</label>
                    <select class="sk-select" :value="(ad.config && ad.config.groupFilter) || 'whitelist'" @change="handleGroupFilter(ad, ($event.target as HTMLSelectElement).value)">
                      <option value="whitelist">白名单（仅允许列表内的群可被回复）</option>
                      <option value="blacklist">黑名单（排除列表内的群，其余均可回复）</option>
                    </select>
                  </div>
                  <div v-if="(ad.config && ad.config.groupFilter) !== 'blacklist'" class="sk-field">
                    <label class="sk-field__label">允许回复的群号</label>
                    <input class="sk-input" type="text" :value="((ad.config && (ad.config.groupAllowlist as unknown as string[])) || []).join(', ')" @change="handleGroupList(ad, 'groupAllowlist', ($event.target as HTMLInputElement).value)" placeholder="输入允许回复的群号，逗号分隔，如 123456789, 987654321" />
                  </div>
                  <div v-else class="sk-field">
                    <label class="sk-field__label">排除回复的群号</label>
                    <input class="sk-input" type="text" :value="((ad.config && (ad.config.groupBlocklist as unknown as string[])) || []).join(', ')" @change="handleGroupList(ad, 'groupBlocklist', ($event.target as HTMLInputElement).value)" placeholder="输入永不回复的群号，逗号分隔，如 123456789（真实群聊建议列入此处）" />
                  </div>
                </template>
                <p class="sk-hint sk-hint--warn">群消息默认关闭。开启后默认「白名单」模式——只有你显式加入允许列表的群才会被回复；选「黑名单」会回复除排除列表外的所有群，请谨慎。</p>
              </div>

              <div class="sk-row sk-row--stack">
                <div class="sk-row__main">
                  <div>
                    <h3 class="sk-row__title">主人绑定</h3>
                    <p class="sk-row__desc">绑定后，这个账号的私聊会并进主对话与记忆。</p>
                  </div>
                </div>
                <div class="sk-row__control">
                  <template v-if="ad.ownerAccount">
                    <span class="sk-badge sk-badge--ok">主人：{{ ad.ownerAccount }}</span>
                    <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" @click="setOwner(ad.id, '')">取消主人</button>
                  </template>
                  <template v-else>
                    <select v-model="(ad as any)._ownerKey" class="sk-select">
                      <option value="">设为某账号为主人…</option>
                      <option v-for="acc in ad.knownAccounts" :key="acc" :value="acc">{{ acc }}</option>
                    </select>
                    <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm" :disabled="!(ad as any)._ownerKey" @click="handleSetOwner(ad)">设为主人</button>
                  </template>
                </div>
              </div>
              <p v-if="!ad.knownAccounts.length" class="sk-hint">连接后收到消息，才会出现可设为主人的账号。</p>
            </div>

            <div v-if="!botReadonly" class="sk-item__ops">
              <button type="button" class="sk-btn sk-btn--primary sk-btn--sm" @click="handleToggle(ad)">{{ ad.connected ? "断开" : "连接" }}</button>
              <button type="button" class="sk-btn sk-btn--ghost sk-btn--sm sk-btn--danger" @click="handleRemove(ad)">删除</button>
            </div>
          </article>
        </div>

        <div v-if="showForm" class="sk-editor">
          <h3 class="sk-editor__title">添加机器人适配器</h3>
          <div class="sk-field">
            <label class="sk-field__label" for="ad-type">协议类型</label>
            <select id="ad-type" v-model="formType" class="sk-select">
              <option value="qqofficial">QQ 官方机器人</option>
              <option value="onebot">OneBot（通用协议端）</option>
            </select>
          </div>
          <div class="sk-grid">
            <div class="sk-field">
              <label class="sk-field__label" for="ad-name">名称</label>
              <input id="ad-name" v-model="formName" class="sk-input" type="text" placeholder="如：我的 QQ 机器人" />
            </div>
            <template v-if="isOneBot">
              <div class="sk-field"><label class="sk-field__label" for="ad-ws">WS 地址</label><input id="ad-ws" v-model="formWsUrl" class="sk-input sk-input--mono" type="text" placeholder="ws://127.0.0.1:3001" /></div>
              <div class="sk-field"><label class="sk-field__label" for="ad-token">访问令牌（可选）</label><input id="ad-token" v-model="formToken" class="sk-input" type="password" placeholder="对应 OneBot 的 access_token" /></div>
            </template>
            <template v-else>
              <div class="sk-field"><label class="sk-field__label" for="ad-appid">AppID</label><input id="ad-appid" v-model="formAppId" class="sk-input" type="text" placeholder="QQ 开放平台 AppID" /></div>
              <div class="sk-field"><label class="sk-field__label" for="ad-secret">Client Secret</label><input id="ad-secret" v-model="formSecret" class="sk-input" type="password" placeholder="QQ 开放平台密钥" /></div>
            </template>
          </div>
          <p v-if="isOneBot" class="sk-hint">群消息策略默认关闭；添加后可以按需配置白名单。</p>
          <p v-else class="sk-hint">在 QQ 开放平台创建机器人后填入 AppID 与 Client Secret。无需公网回调、无需第三方 QQ 客户端在线。</p>
          <p v-if="formError" class="sk-alert sk-alert--error"><SettingsIcon name="alert" /><span>{{ formError }}</span></p>
          <div class="sk-editor__foot">
            <button type="button" class="sk-btn sk-btn--primary" @click="handleAdd">添加</button>
            <button type="button" class="sk-btn sk-btn--ghost" @click="showForm = false">取消</button>
          </div>
        </div>
        <div v-else-if="!botReadonly" class="sk-card__foot">
          <button type="button" class="sk-btn sk-btn--primary" @click="showForm = true"><SettingsIcon name="plus" />添加机器人适配器</button>
        </div>
      </fieldset>
    </div>
  </section>
</template>
