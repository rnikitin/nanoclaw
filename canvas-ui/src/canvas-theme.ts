/**
 * Global Canvas Theme — Radix/Shadcn-inspired dark theme.
 * Agents receive this as `theme` prop: App({ state, send, theme })
 * Also available as `theme` in JSX scope.
 */
export const theme = {
  // Layout
  maxWidth: 860,
  containerPadding: '32px 20px 140px',
  sectionPadding: '8px 0',

  // Typography
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  fontSize: 14,
  lineHeight: 1.7,
  codeFontSize: 13,
  h1Size: 28,
  h2Size: 20,
  h3Size: 16,
  letterSpacing: '-0.02em',

  // Colors — backgrounds (Shadcn dark)
  bg: '#09090b',
  bgSurface: '#0c0c0f',
  bgCard: '#131316',
  bgInput: '#09090b',
  bgCode: '#0f0f12',
  bgHover: '#18181b',
  bgMuted: '#27272a',

  // Colors — text
  text: '#a1a1aa',
  textPrimary: '#a1a1aa',
  textHeading: '#fafafa',
  textHeading2: '#f4f4f5',
  textHeading3: '#e4e4e7',
  textBody: '#a1a1aa',
  textMuted: '#71717a',
  textDim: '#52525b',
  textDimmer: '#3f3f46',

  // Colors — accents
  accent: '#3b82f6',
  accentMuted: '#1d4ed8',
  accentShadow: '#3b82f620',
  approve: '#22c55e',
  approveShadow: '#22c55e20',
  orange: '#f59e0b',
  orangeLight: '#f59e0b20',
  danger: '#ef4444',

  // Colors — borders
  border: '#27272a',
  borderLight: '#1c1c1f',
  borderAccent: '#3b82f640',
  borderCode: '#1c1c1f',

  // Aliases
  btnBorder: '#27272a',
  addBtnBorder: '#27272a',
  addBtnColor: '#52525b',
  sectionBorder: '#18181b',
  inputBg: '#09090b',
  inputBorder: '#27272a',
  codeBg: '#0f0f12',
  codeBorder: '#1c1c1f',
  codeInlineBg: '#18181b',
  codeInlineColor: '#93c5fd',
  commentBoxBg: '#0c0c0f',
  commentBoxBorder: '#3b82f630',
  commentCardBg: '#1a1608',
  commentCardBorder: '#f59e0b25',

  // Sizing
  minTouch: 44,
  minTouchTarget: 44,
  btnHeight: 36,
  bottomBarHeight: 44,
  textareaMaxHeight: 200,
  radius: 8,
  radiusLg: 12,
  radiusSm: 6,

  // Transitions
  transition: 'all 0.15s ease',
};

export type Theme = typeof theme;
