export const cssForge = {
  "palette": {
    "ink": {
      "0": {
        "key": "--palette-ink-0",
        "value": "oklch(100% 0 0)",
        "variable": "--palette-ink-0: oklch(100% 0 0);"
      },
      "50": {
        "key": "--palette-ink-50",
        "value": "oklch(97.642% 0.00132 286.37509)",
        "variable": "--palette-ink-50: oklch(97.642% 0.00132 286.37509);"
      },
      "100": {
        "key": "--palette-ink-100",
        "value": "oklch(94.394% 0.00401 286.32265)",
        "variable": "--palette-ink-100: oklch(94.394% 0.00401 286.32265);"
      },
      "400": {
        "key": "--palette-ink-400",
        "value": "oklch(64.034% 0.01626 285.93162)",
        "variable": "--palette-ink-400: oklch(64.034% 0.01626 285.93162);"
      },
      "700": {
        "key": "--palette-ink-700",
        "value": "oklch(36.391% 0.01708 285.52004)",
        "variable": "--palette-ink-700: oklch(36.391% 0.01708 285.52004);"
      },
      "900": {
        "key": "--palette-ink-900",
        "value": "oklch(20.295% 0.01188 285.29323)",
        "variable": "--palette-ink-900: oklch(20.295% 0.01188 285.29323);"
      },
      "1000": {
        "key": "--palette-ink-1000",
        "value": "oklch(15.155% 0.00852 285.33919)",
        "variable": "--palette-ink-1000: oklch(15.155% 0.00852 285.33919);"
      }
    },
    "accent": {
      "300": {
        "key": "--palette-accent-300",
        "value": "oklch(80.045% 0.10458 161.00822)",
        "variable": "--palette-accent-300: oklch(80.045% 0.10458 161.00822);"
      },
      "500": {
        "key": "--palette-accent-500",
        "value": "oklch(62.932% 0.12965 157.96077)",
        "variable": "--palette-accent-500: oklch(62.932% 0.12965 157.96077);"
      },
      "700": {
        "key": "--palette-accent-700",
        "value": "oklch(47.066% 0.09657 158.37635)",
        "variable": "--palette-accent-700: oklch(47.066% 0.09657 158.37635);"
      }
    },
    "signal": {
      "warn": {
        "key": "--palette-signal-warn",
        "value": "oklch(68.737% 0.14576 62.27382)",
        "variable": "--palette-signal-warn: oklch(68.737% 0.14576 62.27382);"
      },
      "danger": {
        "key": "--palette-signal-danger",
        "value": "oklch(57.196% 0.16866 28.31239)",
        "variable": "--palette-signal-danger: oklch(57.196% 0.16866 28.31239);"
      }
    }
  },
  "theme": {
    "light": {
      "surface": {
        "base": {
          "key": "--theme-light-surface-base",
          "value": "var(--palette-ink-0)",
          "variable": "--theme-light-surface-base: var(--palette-ink-0);"
        },
        "raised": {
          "key": "--theme-light-surface-raised",
          "value": "var(--palette-ink-50)",
          "variable": "--theme-light-surface-raised: var(--palette-ink-50);"
        },
        "sunken": {
          "key": "--theme-light-surface-sunken",
          "value": "var(--palette-ink-100)",
          "variable": "--theme-light-surface-sunken: var(--palette-ink-100);"
        }
      },
      "text": {
        "primary": {
          "key": "--theme-light-text-primary",
          "value": "var(--palette-ink-900)",
          "variable": "--theme-light-text-primary: var(--palette-ink-900);"
        },
        "muted": {
          "key": "--theme-light-text-muted",
          "value": "var(--palette-ink-400)",
          "variable": "--theme-light-text-muted: var(--palette-ink-400);"
        }
      },
      "border": {
        "subtle": {
          "key": "--theme-light-border-subtle",
          "value": "var(--palette-ink-100)",
          "variable": "--theme-light-border-subtle: var(--palette-ink-100);"
        }
      },
      "accent": {
        "base": {
          "key": "--theme-light-accent-base",
          "value": "var(--palette-accent-500)",
          "variable": "--theme-light-accent-base: var(--palette-accent-500);"
        },
        "contrast": {
          "key": "--theme-light-accent-contrast",
          "value": "var(--palette-ink-0)",
          "variable": "--theme-light-accent-contrast: var(--palette-ink-0);"
        }
      }
    },
    "dark": {
      "surface": {
        "base": {
          "key": "--theme-dark-surface-base",
          "value": "var(--palette-ink-1000)",
          "variable": "--theme-dark-surface-base: var(--palette-ink-1000);"
        },
        "raised": {
          "key": "--theme-dark-surface-raised",
          "value": "var(--palette-ink-900)",
          "variable": "--theme-dark-surface-raised: var(--palette-ink-900);"
        },
        "sunken": {
          "key": "--theme-dark-surface-sunken",
          "value": "var(--palette-ink-700)",
          "variable": "--theme-dark-surface-sunken: var(--palette-ink-700);"
        }
      },
      "text": {
        "primary": {
          "key": "--theme-dark-text-primary",
          "value": "var(--palette-ink-50)",
          "variable": "--theme-dark-text-primary: var(--palette-ink-50);"
        },
        "muted": {
          "key": "--theme-dark-text-muted",
          "value": "var(--palette-ink-400)",
          "variable": "--theme-dark-text-muted: var(--palette-ink-400);"
        }
      },
      "border": {
        "subtle": {
          "key": "--theme-dark-border-subtle",
          "value": "var(--palette-ink-700)",
          "variable": "--theme-dark-border-subtle: var(--palette-ink-700);"
        }
      },
      "accent": {
        "base": {
          "key": "--theme-dark-accent-base",
          "value": "var(--palette-accent-300)",
          "variable": "--theme-dark-accent-base: var(--palette-accent-300);"
        },
        "contrast": {
          "key": "--theme-dark-accent-contrast",
          "value": "var(--palette-ink-1000)",
          "variable": "--theme-dark-accent-contrast: var(--palette-ink-1000);"
        }
      }
    }
  },
  "spacing": {
    "custom": {
      "size": {
        "1": {
          "variable": "--spacing-size-1: 0.25rem;",
          "key": "--spacing-size-1",
          "value": "0.25rem"
        },
        "2": {
          "variable": "--spacing-size-2: 0.5rem;",
          "key": "--spacing-size-2",
          "value": "0.5rem"
        },
        "3": {
          "variable": "--spacing-size-3: 0.75rem;",
          "key": "--spacing-size-3",
          "value": "0.75rem"
        },
        "4": {
          "variable": "--spacing-size-4: 1rem;",
          "key": "--spacing-size-4",
          "value": "1rem"
        },
        "6": {
          "variable": "--spacing-size-6: 1.5rem;",
          "key": "--spacing-size-6",
          "value": "1.5rem"
        },
        "8": {
          "variable": "--spacing-size-8: 2rem;",
          "key": "--spacing-size-8",
          "value": "2rem"
        },
        "12": {
          "variable": "--spacing-size-12: 3rem;",
          "key": "--spacing-size-12",
          "value": "3rem"
        },
        "16": {
          "variable": "--spacing-size-16: 4rem;",
          "key": "--spacing-size-16",
          "value": "4rem"
        }
      }
    }
  },
  "typography_fluid": {
    "sans@4xl": {
      "variable": "--typography_fluid-sans-text-4xl: clamp(2.3328rem, 2.0729rem + 1.2996vw, 3.2425rem);",
      "key": "--typography_fluid-sans-text-4xl",
      "value": "clamp(2.3328rem, 2.0729rem + 1.2996vw, 3.2425rem)"
    },
    "sans@3xl": {
      "variable": "--typography_fluid-sans-text-3xl: clamp(1.944rem, 1.7583rem + 0.9286vw, 2.594rem);",
      "key": "--typography_fluid-sans-text-3xl",
      "value": "clamp(1.944rem, 1.7583rem + 0.9286vw, 2.594rem)"
    },
    "sans@2xl": {
      "variable": "--typography_fluid-sans-text-2xl: clamp(1.62rem, 1.4899rem + 0.6503vw, 2.0752rem);",
      "key": "--typography_fluid-sans-text-2xl",
      "value": "clamp(1.62rem, 1.4899rem + 0.6503vw, 2.0752rem)"
    },
    "sans@xl": {
      "variable": "--typography_fluid-sans-text-xl: clamp(1.35rem, 1.2614rem + 0.4431vw, 1.6602rem);",
      "key": "--typography_fluid-sans-text-xl",
      "value": "clamp(1.35rem, 1.2614rem + 0.4431vw, 1.6602rem)"
    },
    "sans@l": {
      "variable": "--typography_fluid-sans-text-l: clamp(1.125rem, 1.067rem + 0.2902vw, 1.3281rem);",
      "key": "--typography_fluid-sans-text-l",
      "value": "clamp(1.125rem, 1.067rem + 0.2902vw, 1.3281rem)"
    },
    "sans@m": {
      "variable": "--typography_fluid-sans-text-m: clamp(0.9375rem, 0.9018rem + 0.1786vw, 1.0625rem);",
      "key": "--typography_fluid-sans-text-m",
      "value": "clamp(0.9375rem, 0.9018rem + 0.1786vw, 1.0625rem)"
    },
    "sans@s": {
      "variable": "--typography_fluid-sans-text-s: clamp(0.7813rem, 0.7616rem + 0.0982vw, 0.85rem);",
      "key": "--typography_fluid-sans-text-s",
      "value": "clamp(0.7813rem, 0.7616rem + 0.0982vw, 0.85rem)"
    },
    "sans@xs": {
      "variable": "--typography_fluid-sans-text-xs: clamp(0.651rem, 0.6428rem + 0.0414vw, 0.68rem);",
      "key": "--typography_fluid-sans-text-xs",
      "value": "clamp(0.651rem, 0.6428rem + 0.0414vw, 0.68rem)"
    }
  },
  "typography": {
    "weight": {
      "sans": {
        "regular": {
          "variable": "--typography-weight-sans-regular: 400;",
          "key": "--typography-weight-sans-regular",
          "value": "400"
        },
        "medium": {
          "variable": "--typography-weight-sans-medium: 500;",
          "key": "--typography-weight-sans-medium",
          "value": "500"
        },
        "bold": {
          "variable": "--typography-weight-sans-bold: 650;",
          "key": "--typography-weight-sans-bold",
          "value": "650"
        }
      }
    }
  }
} as const;