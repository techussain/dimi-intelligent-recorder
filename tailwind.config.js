/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0c0f',
        surface: '#13151a',
        surface2: '#191c22',
        elevated: '#1f232b',
        bd: '#262a33',
        bd2: '#323844',
        fg: '#e8eaed',
        muted: '#9aa0ab',
        accent: {
          // Brand primary. White text on it is ~6.5:1.
          DEFAULT: '#0A6B6B',
          hover: '#0D8080',
          soft: 'rgba(10,107,107,0.22)',
          // Lighter tint for teal TEXT and outlines on dark surfaces (WCAG AA;
          // #0A6B6B itself is only ~3:1 on the dark panels).
          text: '#4FC9C3',
        },
        danger: {
          DEFAULT: '#ef4444',
          hover: '#f87171',
          soft: 'rgba(239,68,68,0.15)',
        },
        success: '#10b981',
        video: { DEFAULT: '#38bdf8', soft: 'rgba(56,189,248,0.14)' },
        audio: { DEFAULT: '#34d399', soft: 'rgba(52,211,153,0.14)' },
        overlay: { DEFAULT: '#e879f9', soft: 'rgba(232,121,249,0.14)' },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 10px 30px rgba(0,0,0,0.35)',
        pop: '0 20px 40px rgba(0,0,0,0.45)',
      },
    },
  },
  plugins: [],
}
