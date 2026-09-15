export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f1edff",
          100: "#e2daff",
          300: "#b7a3ff",
          400: "#9a7bff",
          500: "#7c5cfc",
          600: "#6a3ff0",
          700: "#5730c9",
          900: "#2c1970",
        },
        base: "#0a0c12",
        surface: "#12141d",
        ink: {
          50: "#f4f5f8",
          100: "#e2e4ea",
          200: "#c7cad4",
          300: "#a3a7b6",
          400: "#82869a",
          500: "#5e6275",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 40px -10px rgba(124, 92, 252, 0.45)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #7c5cfc 0%, #22d3ee 100%)",
      },
    },
  },
  plugins: [],
};
