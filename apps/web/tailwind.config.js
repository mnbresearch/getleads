export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fdf4ef",
          100: "#fbe6d9",
          200: "#f3c7a6",
          300: "#e8a172",
          400: "#dc7f4d",
          500: "#c15f37",
          600: "#a3492a",
          700: "#833a23",
          800: "#602a1a",
          900: "#3d1a10",
        },
        base: "#f7f2e9",
        surface: "#fffdf8",
        ink: {
          50: "#211d17",
          100: "#312a20",
          200: "#4c4133",
          300: "#6c5f4c",
          400: "#8c7d67",
          500: "#a8987f",
          600: "#c2b39c",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 40px -12px rgba(193, 95, 55, 0.35)",
        card: "0 1px 2px rgba(49, 42, 32, 0.04), 0 1px 1px rgba(49, 42, 32, 0.03)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #c15f37 0%, #dc7f4d 100%)",
      },
    },
  },
  plugins: [],
};
