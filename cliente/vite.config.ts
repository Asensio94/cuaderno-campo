import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// El núcleo vive fuera de cliente/ (ADR-0001 §11) y lo comparten cliente, servidor y pruebas,
// así que hay que dejar a Vite salir de su raíz para leerlo.
// GitHub Pages sirve el proyecto colgando de `/cuaderno-campo/`, no de la raiz del dominio, y
// eso hay que decirselo a Vite: si no, el HTML pide `/assets/...` y ahi no hay nada. La misma
// ruta manda en el ambito del trabajador de servicio y en el `start_url` del manifiesto.
const BASE = '/cuaderno-campo/';

export default defineConfig({
  base: BASE,
  root: 'cliente',
  server: { fs: { allow: ['..'] } },
  // OPFS con manejadores síncronos solo existe en un trabajador, y crear uno con módulos
  // requiere estas cabeceras en desarrollo igual que en producción.
  optimizeDeps: { exclude: ['wa-sqlite'] },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icono-apple-180.png'],
      manifest: {
        name: 'Cuaderno de campo',
        short_name: 'Cuaderno',
        description: 'Cuaderno de campo naturalista, sin cobertura.',
        lang: 'es',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f5ef',
        theme_color: '#2c362a',
        // Sin iconos no hay instalación: Chrome no ofrece «añadir a la pantalla de inicio» si
        // falta un PNG de 192 y otro de 512. El recortable es el que Android enmascara.
        icons: [
          { src: 'icono-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icono-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icono-recortable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // El .wasm de SQLite y el .tsv del árbol de Aves tienen que estar en la caché o la aplicación
      // no abre —ni identifica— sin cobertura,
      // que es el caso normal en el Pas.
      workbox: { globPatterns: ['**/*.{js,css,html,wasm,svg,woff2,png,tsv,json}'] },
    }),
  ],
});
