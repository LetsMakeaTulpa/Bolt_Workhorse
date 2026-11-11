export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#161615',
          surface: '#1e1e1b',
          elevated: '#262624',
          hover: '#2e2e2a',
          deep: '#121211',
        },
        border: {
          subtle: '#333330',
          DEFAULT: '#3d3d39',
          strong: '#4a4a44',
        },
        accent: {
          DEFAULT: '#b8956a',
          hover: '#a68358',
          subtle: '#2a2418',
          brass: '#c9a96e',
          gold: '#d4af6e',
        },
        olive: {
          DEFAULT: '#7a8450',
          hover: '#6b7544',
          subtle: '#2a3020',
          muted: '#5c6640',
        },
        text: {
          primary: '#e5e3df',
          secondary: '#a8a59f',
          muted: '#71706a',
          dim: '#52524e',
        },
        success: '#7a8450',
        warning: '#c9a96e',
        error: '#b85450',
        info: '#6a7a8c',
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
          '0%': { boxShadow: '0 0 2px rgba(184,149,106,0.2)' },
          '100%': { boxShadow: '0 0 8px rgba(184,149,106,0.4)' },
        },
      },
    },
  },
  plugins: [],
}
