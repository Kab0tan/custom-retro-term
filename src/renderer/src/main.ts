import { createApp } from 'vue'
import '@xterm/xterm/css/xterm.css'
// Bundled retro fonts (OFL). See BUNDLED_FONTS in src/shared/settings.ts.
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@fontsource/vt323/400.css'
import '@fontsource/share-tech-mono/400.css'
import '@fontsource/courier-prime/400.css'
import '@fontsource/courier-prime/700.css'
import './styles.css'
import App from './App.vue'

createApp(App).mount('#app')
