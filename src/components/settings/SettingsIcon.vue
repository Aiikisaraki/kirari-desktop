<script setup lang="ts">
/**
 * 设置界面图标集（两端同一份，线性内联 SVG，随 currentColor 变色）。
 * 不用 emoji：跨平台字形不一致，字号基线也难对齐。
 */
withDefaults(defineProps<{ name?: string }>(), { name: "sparkles" });
</script>

<template>
    <svg
        class="sk-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <template v-if="name === 'sparkles'">
            <path d="M12 3.6 13.6 8.4 18.4 10 13.6 11.6 12 16.4 10.4 11.6 5.6 10 10.4 8.4Z" />
            <path d="M18.4 15.2 19.1 17 20.9 17.7 19.1 18.4 18.4 20.2 17.7 18.4 15.9 17.7 17.7 17 18.4 15.2Z" />
        </template>
        <template v-else-if="name === 'paw'">
            <circle cx="7.2" cy="11.2" r="1.55" />
            <circle cx="10.1" cy="8.5" r="1.65" />
            <circle cx="13.9" cy="8.5" r="1.65" />
            <circle cx="16.8" cy="11.2" r="1.55" />
            <path d="M12 20.2c-2.85 0-4.95-1.6-4.95-3.85 0-1.9 1.95-3.35 4.95-3.35s4.95 1.45 4.95 3.35c0 2.25-2.1 3.85-4.95 3.85Z" />
        </template>
        <template v-else-if="name === 'sliders'">
            <path d="M4 7h16M4 12h16M4 17h16" />
            <circle cx="9.5" cy="7" r="1.9" />
            <circle cx="15" cy="12" r="1.9" />
            <circle cx="7.5" cy="17" r="1.9" />
        </template>
        <template v-else-if="name === 'user'">
            <circle cx="12" cy="8.2" r="3.5" />
            <path d="M5.2 20c1.1-3.2 3.7-4.9 6.8-4.9s5.7 1.7 6.8 4.9" />
        </template>
        <path v-else-if="name === 'heart'" d="M12 20.3C6.4 16.9 3.5 13.7 3.5 10.2 3.5 7.6 5.5 5.7 8 5.7c1.6 0 3.1.8 4 2.1.9-1.3 2.4-2.1 4-2.1 2.5 0 4.5 1.9 4.5 4.5 0 3.5-2.9 6.7-8.5 10.1Z" />
        <template v-else-if="name === 'cpu'">
            <rect x="6.6" y="6.6" width="10.8" height="10.8" rx="2.4" />
            <rect x="10.4" y="10.4" width="3.2" height="3.2" rx="0.6" />
            <path d="M9 3.2v3.4M15 3.2v3.4M9 17.4v3.4M15 17.4v3.4M3.2 9h3.4M3.2 15h3.4M17.4 9h3.4M17.4 15h3.4" />
        </template>
        <template v-else-if="name === 'wand'">
            <path d="M3.5 20.5 13 11" />
            <path d="M14.8 4 15.6 6 17.6 6.8 15.6 7.6 14.8 9.6 14 7.6 12 6.8 14 6Z" />
            <path d="M19.2 12.6 19.8 14.1 21.3 14.7 19.8 15.3 19.2 16.8 18.6 15.3 17.1 14.7 18.6 14.1Z" />
        </template>
        <template v-else-if="name === 'book'">
            <path d="M4 19.3V5.6A2.4 2.4 0 0 1 6.4 3.2H20v17.6H6.4A2.4 2.4 0 0 1 4 18.4Z" />
            <path d="M4 18.4A2.4 2.4 0 0 1 6.4 16H20" />
        </template>
        <template v-else-if="name === 'plug'">
            <path d="M9 7.2V3.5M15 7.2V3.5" />
            <path d="M6.8 7.2h10.4v3.6a5.2 5.2 0 0 1-10.4 0Z" />
            <path d="M12 16.4v4.1" />
        </template>
        <template v-else-if="name === 'bot'">
            <rect x="4.8" y="8.4" width="14.4" height="10.8" rx="3.2" />
            <path d="M12 8.4V5.6" />
            <circle cx="12" cy="4.2" r="1.3" />
            <path d="M9.6 13v1.6M14.4 13v1.6" />
        </template>
        <template v-else-if="name === 'sync'">
            <path d="M20 7.2H7.2M7.2 7.2l3.1-3.1M7.2 7.2l3.1 3.1" />
            <path d="M4 16.8h12.8M16.8 16.8l-3.1-3.1M16.8 16.8l-3.1 3.1" />
        </template>
        <path v-else-if="name === 'chat'" d="M12 3.2a8.8 8.8 0 0 0-7.6 13.2L3 21l4.7-1.3A8.8 8.8 0 1 0 12 3.2Z" />
        <template v-else-if="name === 'sun'">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4" />
        </template>
        <path v-else-if="name === 'moon'" d="M20 14.6A8.6 8.6 0 0 1 9.4 4 8.6 8.6 0 1 0 20 14.6Z" />
        <template v-else-if="name === 'auto'">
            <rect x="3.4" y="4.6" width="17.2" height="11.8" rx="2" />
            <path d="M9 20.4h6M12 16.4v4" />
        </template>
        <path v-else-if="name === 'plus'" d="M12 5.2v13.6M5.2 12h13.6" />
        <template v-else-if="name === 'trash'">
            <path d="M4 6.5h16" />
            <path d="M9.2 6.5V4.7a1.6 1.6 0 0 1 1.6-1.6h2.4a1.6 1.6 0 0 1 1.6 1.6v1.8" />
            <path d="M18.4 6.5l-.8 12.3a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.6 6.5" />
        </template>
        <template v-else-if="name === 'edit'">
            <path d="M4 20h4.2L20 8.2 15.8 4 4 15.8Z" />
            <path d="M14 5.8 18.2 10" />
        </template>
        <template v-else-if="name === 'copy'">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M6.4 15H5.4A1.4 1.4 0 0 1 4 13.6V5.4A1.4 1.4 0 0 1 5.4 4h8.2A1.4 1.4 0 0 1 15 5.4v1" />
        </template>
        <path v-else-if="name === 'check'" d="M5 12.6l4.5 4.5L19 6.8" />
        <template v-else-if="name === 'alert'">
            <circle cx="12" cy="12" r="8.8" />
            <path d="M12 7.6v5.2" />
            <path d="M12 16.2h.01" />
        </template>
        <template v-else-if="name === 'info'">
            <circle cx="12" cy="12" r="8.8" />
            <path d="M12 11v5.2" />
            <path d="M12 7.8h.01" />
        </template>
        <template v-else-if="name === 'upload'">
            <path d="M12 16V4.4M12 4.4 8.4 8M12 4.4 15.6 8" />
            <path d="M4.5 15.4v3.2a1.6 1.6 0 0 0 1.6 1.6h11.8a1.6 1.6 0 0 0 1.6-1.6v-3.2" />
        </template>
        <path v-else-if="name === 'folder'" d="M3.4 7.4A2 2 0 0 1 5.4 5.4h3.3l1.6 2.1h7.9a2 2 0 0 1 2 2v8.1a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2Z" />
        <template v-else-if="name === 'search'">
            <circle cx="11" cy="11" r="6.4" />
            <path d="M15.8 15.8l4.8 4.8" />
        </template>
        <template v-else-if="name === 'qr'">
            <rect x="4" y="4" width="6.2" height="6.2" rx="1" />
            <rect x="13.8" y="4" width="6.2" height="6.2" rx="1" />
            <rect x="4" y="13.8" width="6.2" height="6.2" rx="1" />
            <path d="M13.8 13.8h2.6v2.6h-2.6zM18.6 13.8h1.4v1.4M14 18.2h2.2v1.8M18.6 18.2h1.4" />
        </template>
        <template v-else-if="name === 'external'">
            <path d="M14.6 4.4h5v5M19.6 4.4 12 12" />
            <path d="M18.6 14.2v4.4a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8V7a1.8 1.8 0 0 1 1.8-1.8h4.4" />
        </template>
        <path v-else-if="name === 'refresh'" d="M20 12a8 8 0 1 1-2.6-5.9M20 3.8v4.4h-4.4" />
        <template v-else-if="name === 'key'">
            <circle cx="8.2" cy="15.8" r="3.4" />
            <path d="M10.9 13.1 19.4 4.6M16.6 4.6h2.8v2.8" />
        </template>
        <template v-else>
            <circle cx="12" cy="12" r="8.6" />
        </template>
    </svg>
</template>
