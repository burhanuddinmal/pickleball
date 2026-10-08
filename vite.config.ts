import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  return {
    base: './',
    server: { host: true, port: 5173 },
    build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
    plugins: [
      {
        name: 'platform-sdk-injector',
        transformIndexHtml(html: string) {
          let scriptTag = '';
          if (mode === 'crazygames') {
            scriptTag = '<script src="https://sdk.crazygames.com/crazygames-sdk-v2.js"></script>';
          } else if (mode === 'playgama') {
            scriptTag = '<script src="https://bridge.playgama.com/v2/stable/playgama-bridge.js"></script>';
          }
          if (scriptTag) {
            return html.replace('</head>', `  ${scriptTag}\n  </head>`);
          }
          return html;
        },
      },
    ],
  } as never;
});
