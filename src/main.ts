import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import './style.css'
import './components/settings/settings.css'
import 'katex/dist/katex.min.css'
import App from './App.vue'
import { useThemeStore } from './stores/theme'

const pinia = createPinia()
const app = createApp(App).use(pinia)

// 主题在挂载前同步落定：index.html 已默认 aurora-glass，
// 若加载 URL 含 ?theme= 则立即覆盖，避免首帧闪烁。
setActivePinia(pinia)
useThemeStore().init()

app.mount('#app')
