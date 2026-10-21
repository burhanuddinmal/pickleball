import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Play Store package name: permanent once the first release is uploaded.
  appId: 'com.picklesmash.game',
  appName: 'Pickle Smash',
  webDir: 'dist',
  android: {
    // Release builds never allow mixed content or WebView debugging.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: { launchAutoHide: false },
  },
};

export default config;
