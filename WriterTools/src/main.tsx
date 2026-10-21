import { createRoot } from 'react-dom/client';
import App from './ui/App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');
createRoot(rootEl).render(<App />);

// PWA：生产环境注册 Service Worker，离线可用；开发环境不注册以避免缓存困扰。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 离线能力是增强项，注册失败不影响主功能 */
    });
  });
}
