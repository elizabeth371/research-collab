/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 墨蓝主色 (学术蓝墨风)
        ink: {
          DEFAULT: '#1F3A5F',
          hover: '#2A4C78',
          light: '#EAF0F7',
          lighter: '#F5F8FC',
        },
        // 强调蓝
        accent: {
          DEFAULT: '#1D4ED8',
          hover: '#1E40AF',
          light: '#EFF4FF',
        },
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
      fontFamily: {
        serif: ['"Noto Serif SC"', '"Songti SC"', 'SimSun', 'serif'],
      },
    },
  },
  plugins: [],
};