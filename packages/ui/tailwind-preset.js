module.exports = {
  theme: {
    extend: {
      colors: {
        "ui-paper": "rgb(var(--ui-paper) / <alpha-value>)",
        "ui-surface": "rgb(var(--ui-surface) / <alpha-value>)",
        "ui-highlight": "rgb(var(--ui-highlight) / <alpha-value>)",
        "ui-ink": "rgb(var(--ui-ink) / <alpha-value>)",
        "ui-muted": "rgb(var(--ui-muted) / <alpha-value>)",
        "ui-border": "rgb(var(--ui-border) / <alpha-value>)",
        "ui-accent": "rgb(var(--ui-accent) / <alpha-value>)",
        "ui-accent-ink": "rgb(var(--ui-accent-ink) / <alpha-value>)",
        "ui-accent-hover": "rgb(var(--ui-accent-hover) / <alpha-value>)",
        "ui-accent-soft": "rgb(var(--ui-accent-soft) / <alpha-value>)"
      },
      fontFamily: {
        sans: "var(--font-sans)",
        display: "var(--font-display)",
        mono: "var(--font-mono)"
      },
      boxShadow: {
        soft: "var(--ui-shadow-soft)"
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" }
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        "slide-down": {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(14px)" }
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.98)" },
          "100%": { opacity: "1", transform: "scale(1)" }
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" }
        },
        "shimmer": {
          "0%": { "background-position": "200% 0" },
          "100%": { "background-position": "-200% 0" }
        },
        "slide-in-right": {
          "0%": { opacity: "0", transform: "translateX(16px)" },
          "100%": { opacity: "1", transform: "translateX(0)" }
        },
        "slide-out-right": {
          "0%": { opacity: "1", transform: "translateX(0)" },
          "100%": { opacity: "0", transform: "translateX(16px)" }
        }
      },
      animation: {
        "fade-in": "fade-in 220ms ease-out",
        "fade-up": "fade-up 240ms ease-out",
        "slide-up": "slide-up 240ms ease-out",
        "slide-down": "slide-down 200ms ease-in forwards",
        "scale-in": "scale-in 200ms ease-out",
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
        "shimmer": "shimmer 2s ease-in-out infinite",
        "slide-in-right": "slide-in-right 200ms ease-out",
        "slide-out-right": "slide-out-right 150ms ease-in forwards"
      }
    }
  }
};
