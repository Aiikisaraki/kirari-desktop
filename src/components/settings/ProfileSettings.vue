<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useUserProfileStore } from "../../stores/userProfile";

const store = useUserProfileStore();
const isPicking = ref(false);

async function handlePick() {
  isPicking.value = true;
  try {
    const url = await store.pickAvatar();
    if (!url && store.lastError) {
      // 用户取消不会写 lastError；仅真正失败才提示。
    }
  } finally {
    isPicking.value = false;
  }
}

async function handleRemove() {
  await store.clearAvatar();
}

onMounted(() => {
  void store.init();
});
</script>

<template>
  <div class="settings-profile-wrap">
    <section id="profile" class="settings-card">
      <h3 class="settings-card__title">
        <span class="title-emoji">👤</span>
        <span>我的头像</span>
      </h3>
      <p class="settings-card__desc">
        聊天时代表你的头像。图片只会保存在你的电脑本地，不会上传到任何服务器。
      </p>

      <!-- 头像预览 + 操作 -->
      <div class="profile-head">
        <div class="profile-avatar-preview">
          <img
            v-if="store.avatar"
            class="profile-avatar-preview__img"
            :src="store.avatar"
            alt="我的头像"
          />
          <div v-else class="profile-avatar-preview__placeholder">你</div>
        </div>
        <div class="profile-actions">
          <button
            type="button"
            class="btn btn--import"
            :disabled="isPicking"
            @click="handlePick"
          >
            <svg
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 15V8m0 0L8.5 11.5M12 8l3.5 3.5" />
              <path d="M20 16.5A4.5 4.5 0 0 0 17.5 8h-1.3A6 6 0 1 0 6 14.6" />
            </svg>
            <span>{{ isPicking ? "选择中…" : store.avatar ? "更换图片" : "选择图片" }}</span>
          </button>
          <button
            v-if="store.avatar"
            type="button"
            class="btn btn--ghost"
            @click="handleRemove"
          >
            <svg
              viewBox="0 0 24 24"
              width="17"
              height="17"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            <span>移除</span>
          </button>
        </div>
      </div>

      <div v-if="store.lastError" class="settings-error">{{ store.lastError }}</div>

      <p class="profile-tip">
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5" />
          <path d="M12 7.5h.01" />
        </svg>
        <span>支持 PNG / JPG / GIF / WebP / BMP。设置后即时在聊天窗口生效；移除即恢复默认占位头像。</span>
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings-profile-wrap {
  display: block;
}

.profile-avatar-preview {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #9aa3b5, #7c8597);
  box-shadow: 0 6px 18px rgba(57, 44, 76, 0.18);
  flex: 0 0 auto;
}

.profile-avatar-preview__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.profile-avatar-preview__placeholder {
  font-size: 34px;
  font-weight: 800;
  color: #fff;
  user-select: none;
}

.profile-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.profile-actions .btn svg {
  width: 17px;
  height: 17px;
  flex: 0 0 auto;
}

/* 头像预览 + 操作按钮：左图右操作，垂直居中，窄屏自动换行 */
.profile-head {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.profile-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 14px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--pet-muted);
}

.profile-tip svg {
  flex: 0 0 auto;
  margin-top: 2px;
}
</style>
