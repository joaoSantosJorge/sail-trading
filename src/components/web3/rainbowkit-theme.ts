import { lightTheme, type Theme } from "@rainbow-me/rainbowkit";

/**
 * RainbowKit modal theme mapped onto the app's OKLCH design tokens. Every
 * color is a CSS-var reference, so the modal follows light/dark automatically
 * when next-themes flips `.dark` — no theme-object switching, no hydration
 * flash. Base is lightTheme() so any key we don't override stays sane.
 */
const base = lightTheme({ borderRadius: "small" });

export const rainbowKitTheme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    accentColor: "var(--primary)",
    accentColorForeground: "var(--primary-foreground)",
    actionButtonBorder: "var(--border)",
    actionButtonBorderMobile: "var(--border)",
    actionButtonSecondaryBackground: "var(--secondary)",
    closeButton: "var(--muted-foreground)",
    closeButtonBackground: "var(--secondary)",
    connectButtonBackground: "var(--card)",
    connectButtonInnerBackground: "var(--secondary)",
    connectButtonText: "var(--foreground)",
    error: "var(--destructive)",
    generalBorder: "var(--border)",
    generalBorderDim: "var(--border)",
    menuItemBackground: "var(--accent)",
    modalBackdrop: "oklch(0.145 0.02 260 / 0.5)",
    modalBackground: "var(--popover)",
    modalBorder: "var(--border)",
    modalText: "var(--popover-foreground)",
    modalTextDim: "var(--muted-foreground)",
    modalTextSecondary: "var(--muted-foreground)",
    profileAction: "var(--secondary)",
    profileActionHover: "var(--accent)",
    profileForeground: "var(--popover)",
    selectedOptionBorder: "var(--ring)",
  },
  shadows: {
    ...base.shadows,
    dialog: "var(--elevation-lg)",
  },
  fonts: {
    body: "inherit",
  },
};
