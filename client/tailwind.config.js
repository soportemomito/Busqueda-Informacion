/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
      },
      colors: {
        momo: {
          50: '#f4f7fb',
          100: '#e8eef6',
          200: '#c9d7e8',
          300: '#9bb4d4',
          400: '#678cbb',
          500: '#456fa8',
          600: '#34588d',
          700: '#2b4773',
          800: '#273d60',
          900: '#243551',
        },
      },
    },
  },
  plugins: [],
};
