<script setup lang="ts">
interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

const props = defineProps<{
  x: number;
  y: number;
  items: MenuItem[];
}>();

const emit = defineEmits<{ close: [] }>();

function pick(item: MenuItem) {
  if (item.disabled) return;
  item.onClick();
  emit("close");
}
</script>

<template>
  <!-- 点击空白处 / 在别处右键：关闭菜单 -->
  <div
    class="ctx-backdrop"
    @click="emit('close')"
    @contextmenu.prevent="emit('close')"
  >
    <ul
      class="ctx-menu"
      :style="{ left: `${props.x}px`, top: `${props.y}px` }"
      role="menu"
      @click.stop
      @contextmenu.stop.prevent
    >
      <li
        v-for="(item, i) in props.items"
        :key="i"
        class="ctx-item"
        :class="{ 'is-danger': item.danger, 'is-disabled': item.disabled }"
        role="menuitem"
        @click="pick(item)"
      >
        {{ item.label }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.ctx-menu {
  position: fixed;
  min-width: 160px;
  margin: 0;
  padding: 6px;
  list-style: none;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--pet-border, rgba(0, 0, 0, 0.08));
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(57, 44, 76, 0.18);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  user-select: none;
  font-size: 13px;
  color: var(--pet-ink, #2b2438);
  animation: ctx-pop 0.1s ease-out;
}

@keyframes ctx-pop {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.ctx-item {
  padding: 8px 12px;
  border-radius: 9px;
  cursor: pointer;
  line-height: 1.3;
  transition: background 120ms ease;
}

.ctx-item:hover {
  background: var(--pet-accent-soft, rgba(167, 139, 250, 0.16));
}

.ctx-item.is-danger {
  color: #b23a4a;
}

.ctx-item.is-danger:hover {
  background: rgba(214, 110, 130, 0.16);
}

.ctx-item.is-disabled {
  opacity: 0.45;
  cursor: default;
  pointer-events: none;
}
</style>
