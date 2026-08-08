import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor packaging configuration.
 *
 * The build output is a self-contained static web app - no runtime network
 * access, no external assets - so it runs unchanged inside a WebView.
 *
 * Install the toolchain before using this:
 *   npm i -D @capacitor/cli @capacitor/core
 *   npm i @capacitor/android @capacitor/ios
 *   npm run build && npx cap add android && npx cap sync
 */
const config: CapacitorConfig = {
  appId: 'de.grayzone.protocol',
  appName: 'Grayzone Protocol',
  webDir: 'dist',

  android: {
    // The renderer writes to a canvas every frame; the hardware-accelerated
    // WebView is not optional for hitting 60 FPS.
    webContentsDebuggingEnabled: false,
    // Keep the WebView from intercepting the back gesture mid-raid; the game
    // handles its own navigation through the screen stack.
    allowMixedContent: false,
  },

  ios: {
    // Prevents the rubber-band bounce that would otherwise fight the look
    // controls on the right half of the screen.
    scrollEnabled: false,
    contentInset: 'never',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#0b0d10',
      showSpinner: false,
    },
    StatusBar: {
      // The HUD extends under the status bar and pads with safe-area insets.
      overlaysWebView: true,
      style: 'DARK',
      backgroundColor: '#00000000',
    },
  },
};

export default config;
