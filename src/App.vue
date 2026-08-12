<script setup lang="ts">
import ChatWindow from './components/chat/ChatWindow.vue'
import MediaViewer from './components/viewer/MediaViewer.vue'
import PetStage from './components/pet/PetStage.vue'
import SettingsPage from './components/settings/SettingsPage.vue'

const params = new URLSearchParams(window.location.search)
const windowType = params.get('window')
const isChatWindow = windowType === 'chat'
const isSettingsWindow = windowType === 'settings'
const isViewerWindow = windowType === 'viewer'
// viewer 窗口：从 URL 读取 src / kind 传给 MediaViewer
const viewerSrc = decodeURIComponent(params.get('src') || '')
const viewerKind = params.get('kind') === 'video' ? 'video' : 'image'
</script>

<template>
  <SettingsPage v-if="isSettingsWindow" />
  <ChatWindow v-else-if="isChatWindow" />
  <MediaViewer v-else-if="isViewerWindow" :src="viewerSrc" :kind="viewerKind" />
  <main v-else class="desktop-pet-app" aria-label="Kirari绮莉 桌宠">
    <PetStage />
  </main>
</template>
