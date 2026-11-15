export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0a0a0b',
          surface: '#121214',
          elevated: '#1a1a1d',
          hover: '#232327',
          deep: '#050506',
        },
        border: {
          subtle: '#1e1e21',
          DEFAULT: '#2a2a2f',
          strong: '#3d3d44',
        },
        accent: {
          DEFAULT: '#b9bec6',
          hover: '#d2d6dc',
          subtle: '#1c1c1f',
          brass: '#9aa0a8',
          gold: '#dfe2e7',
        },
        olive: {
          DEFAULT: '#9aa0a8',
          hover: '#b3b9c1',
          subtle: '#1b1b1e',
          muted: '#6e737a',
        },
        text: {
          primary: '#e3e4e6',
          secondary: '#a8abb0',
          muted: '#868a90',
          dim: '#565a60',
        },
        // status colours are grey first; the remaining hue is just enough to tell them apart
        // (<=9% saturation), and `subtle` gives each one a background for badges and banners
        success: { DEFAULT: '#8e9a92', subtle: '#141715' },
        warning: { DEFAULT: '#aaa7a1', subtle: '#171614' },
        error: { DEFAULT: '#a79597', subtle: '#1a1415' },
        info: { DEFAULT: '#9aa3ad', subtle: '#14161a' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        serif: ['Lora', 'Georgia', 'serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'slide-right': 'slideRight 0.3s ease-out',
        'pulse-slow': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'thinking': 'thinking 1.4s ease-in-out infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideRight: {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
        thinking: {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
        glow: {
          '0%': { boxShadow: '0 0 2px rgba(201,206,212,0.14)' },
          '100%': { boxShadow: '0 0 8px rgba(201,206,212,0.28)' },
        },
      },
    },
  },
  plugins: [],
}
