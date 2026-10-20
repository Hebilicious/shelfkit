import { defineConfig } from "@hebilicious/cssforge";

/**
 * The ShelfKit design tokens.
 *
 * CSSForge has no bundler plugin, so generation is a prebuild step and the
 * output is committed. Components consume `var(--...)` and the typed token
 * object, never raw values. See docs/PRD.md section 9.3.
 */
export default defineConfig({
  colors: {
    palette: {
      value: {
        ink: {
          value: {
            0: { hex: "#ffffff" },
            50: { hex: "#f7f7f8" },
            100: { hex: "#ececef" },
            400: { hex: "#8b8b96" },
            700: { hex: "#3d3d47" },
            900: { hex: "#16161c" },
            1000: { hex: "#0b0b0f" },
          },
        },
        accent: {
          value: {
            300: { hex: "#7dd3a8" },
            500: { hex: "#2fa06a" },
            700: { hex: "#1c6b46" },
          },
        },
        signal: {
          value: {
            warn: { hex: "#d98324" },
            danger: { hex: "#c8453a" },
          },
        },
      },
    },
    theme: {
      light: {
        value: {
          surface: {
            value: {
              base: "var(--1)",
              raised: "var(--2)",
              sunken: "var(--3)",
            },
            variables: {
              1: "palette.ink.0",
              2: "palette.ink.50",
              3: "palette.ink.100",
            },
          },
          text: {
            value: {
              primary: "var(--1)",
              muted: "var(--2)",
            },
            variables: {
              1: "palette.ink.900",
              2: "palette.ink.400",
            },
          },
          border: {
            value: { subtle: "var(--1)" },
            variables: { 1: "palette.ink.100" },
          },
          accent: {
            value: {
              base: "var(--1)",
              contrast: "var(--2)",
            },
            variables: {
              1: "palette.accent.500",
              2: "palette.ink.0",
            },
          },
          signal: {
            value: {
              warn: "var(--1)",
              danger: "var(--2)",
              info: "var(--3)",
            },
            variables: {
              1: "palette.signal.warn",
              2: "palette.signal.danger",
              3: "palette.accent.700",
            },
          },
        },
      },
      dark: {
        value: {
          surface: {
            value: {
              base: "var(--1)",
              raised: "var(--2)",
              sunken: "var(--3)",
            },
            variables: {
              1: "palette.ink.1000",
              2: "palette.ink.900",
              3: "palette.ink.700",
            },
          },
          text: {
            value: {
              primary: "var(--1)",
              muted: "var(--2)",
            },
            variables: {
              1: "palette.ink.50",
              2: "palette.ink.400",
            },
          },
          border: {
            value: { subtle: "var(--1)" },
            variables: { 1: "palette.ink.700" },
          },
          accent: {
            value: {
              base: "var(--1)",
              contrast: "var(--2)",
            },
            variables: {
              1: "palette.accent.300",
              2: "palette.ink.1000",
            },
          },
          signal: {
            value: {
              warn: "var(--1)",
              danger: "var(--2)",
              info: "var(--3)",
            },
            variables: {
              1: "palette.signal.warn",
              2: "palette.signal.danger",
              3: "palette.accent.300",
            },
          },
        },
        settings: {
          atRule: "@media (prefers-color-scheme: dark)",
        },
      },
    },
  },
  primitives: {
    font: {
      value: {
        family: {
          value: {
            sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
            mono: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
          },
        },
        leading: {
          value: {
            tight: "1.25",
            normal: "1.5",
          },
        },
      },
    },
    layout: {
      value: {
        radius: {
          value: {
            s: "0.25rem",
            m: "0.5rem",
            pill: "999rem",
          },
        },
        border: {
          value: {
            hairline: "1px",
            thick: "2px",
          },
        },
        measure: {
          value: {
            rail: "18rem",
            pane: "22rem",
            prose: "68ch",
            page: "96ch",
            wide: "108ch",
          },
        },
        offset: {
          value: {
            header: "4rem",
            panes: "8rem",
          },
        },
      },
    },
  },
  spacing: {
    custom: {
      size: {
        value: {
          1: "0.25rem",
          2: "0.5rem",
          3: "0.75rem",
          4: "1rem",
          6: "1.5rem",
          8: "2rem",
          12: "3rem",
          16: "4rem",
        },
      },
    },
  },
  typography: {
    fluid: {
      sans: {
        value: {
          minWidth: 320,
          minFontSize: 15,
          minTypeScale: 1.2,
          maxWidth: 1440,
          maxFontSize: 17,
          maxTypeScale: 1.25,
          positiveSteps: 5,
          negativeSteps: 2,
          prefix: "text",
        },
      },
    },
    weight: {
      sans: {
        value: {
          regular: "400",
          medium: "500",
          bold: "650",
        },
      },
    },
  },
});
