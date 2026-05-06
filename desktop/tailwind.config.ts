/** @type {import('tailwindcss').Config} */
export default {
    content: [
      "./index.html",
      "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
      extend: {
        colors: {
          mole: {
            dark: '#2c1810',
            darker: '#1f1008',
            card: '#3d2418',
            accent: '#f5c542',
            'accent-hover': '#e0b038',
            light: '#f7f2eb',
            gray: '#faf6f1',
            'text-muted': 'rgba(255,255,255,0.6)',
            'text-dim': 'rgba(255,255,255,0.4)',
            'border-light': 'rgba(255,255,255,0.1)',
            'border-dark': '#d4c8b8',
            delete: '#c45c5c',
            pink: '#e89b9b',
          },
        },
        fontFamily: {
          sans: ['Inter', 'system-ui', 'sans-serif'],
          mono: ['JetBrains Mono', 'monospace'],
        },
        borderRadius: {
          'xl': '16px',
          '2xl': '24px',
          'pill': '50px',
        },
        boxShadow: {
          'soft': '0 2px 8px rgba(0,0,0,0.08)',
          'medium': '0 8px 24px rgba(0,0,0,0.12)',
          'prominent': '0 16px 48px rgba(0,0,0,0.16)',
        },
      },
    },
    plugins: [],
  }