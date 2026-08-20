/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // AI 内容作者着色 (蓝色系)
        'ai-author': {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
        },
        // 人类输入 (白色/中性色)
        'human-author': {
          50: '#f9fafb',
          100: '#f3f4f6',
        },
      },
    },
  },
  plugins: [],
};