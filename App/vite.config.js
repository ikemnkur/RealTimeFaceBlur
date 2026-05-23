import { defineConfig } from 'vite';

// Maps clean URL paths → actual HTML files served by the dev server.
// Vercel handles the same mapping in vercel.json via "rewrites".
const ROUTE_MAP = {
  '/login':           '/login.html',
  '/register':        '/login.html',
  '/forgot-password': '/login.html',
  '/webcam':          '/webcam.html',
  '/video':           '/video.html',
  '/video-pro':       '/video-pro.html',
  '/video-advanced':  '/video-advanced.html',
  '/tutorial':        '/tutorial.html',
  '/support':         '/support.html',
  '/checkout':        '/checkout.html',
  '/success':         '/success.html',
  '/cancel':          '/cancel.html',
  '/dashboard':       '/dashboard.html',
  '/plans':           '/plans.html',
};

function cleanRoutesPlugin() {
  return {
    name: 'clean-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? '').split('?')[0];
        const qs   = req.url?.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
        if (ROUTE_MAP[path]) req.url = ROUTE_MAP[path] + qs;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [cleanRoutesPlugin()],
  root: '.',
  // Treat all HTML files as entry points
  build: {
    rollupOptions: {
      input: {
        main:         'index.html',
        login:        'login.html',
        webcam:       'webcam.html',
        video:        'video.html',
        videoPro:     'video-pro.html',
        videoAdv:     'video-advanced.html',
        videoMobile:  'video-mobile.html',
        tutorial:     'tutorial.html',
        support:      'support.html',
        checkout:     'checkout.html',
        success:      'success.html',
        cancel:       'cancel.html',
        dashboard:    'dashboard.html',
        plans:        'plans.html',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    open: '/index.html',
    // Proxy API calls to the local backend so you don't need CORS in dev
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
