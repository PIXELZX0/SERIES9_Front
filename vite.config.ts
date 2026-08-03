import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// GitHub Pages serves this repo under /SERIES9_Front/, so CI sets VITE_BASE.
// Local dev and any root-hosted deploy (server.mjs) keep the default '/'.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
})
