/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'Plus Jakarta Sans', 'system-ui', 'sans-serif'],
      },
      colors: {
        momo: {
          50: '#f8f6ff',
          100: '#f0ebff',
          200: '#e1d7ff',
          300: '#cbb8ff',
          400: '#ab8eff',
          500: '#8c5eff',
          600: '#723bf5',
          700: '#5e27db',
          800: '#4e1eb8',
          900: '#3d1694',
        },
      },
    },
  },
  plugins: [],
};
