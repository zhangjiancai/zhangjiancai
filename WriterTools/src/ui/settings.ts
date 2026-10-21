/**
 * 应用级设置：localStorage 持久化、主题应用、快捷键解析与格式化。
 *
 * 约束：
 * - 所有设置项都集中在这里定义默认值、取值范围与校验，界面只读 AppSettings。
 * - 主题通过 document.documentElement.dataset.theme 应用（system/light/dark），
 *   浅色背景通过 dataset.lightBg 应用（white/cream），CSS 变量全部在 styles.css。
 */
import type { EditorMode } from '../engine/types';

export type ThemeMode = 'system' | 'light' | 'dark';
export type LightBackground = 'white' | 'cream';

/** 自定义快捷键：修饰键 + 小写键名（如 's' / 'enter' / 'f2'）。 */
export interface ShortcutBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export interface AppSettings {
  /** 明暗主题偏好 */
  theme: ThemeMode;
  /** 浅色主题下的背景：纯白 / 奶白 */
  lightBackground: LightBackground;
  /** 打开作品时的默认排版模式 */
  mode: EditorMode;
  /** 正文字号（px） */
  fontSize: number;
  /** 行宽（em，相对正文字号的字符宽度） */
  lineWidth: number;
  /** 是否记录输入法原始过程（compose.* 事件） */
  recordComposition: boolean;
  /** 手动保存（立即快照）快捷键 */
  saveShortcut: ShortcutBinding;
}

export const APP_VERSION = '0.2.0';
export const SETTINGS_STORAGE_KEY = 'writertools.settings.v1';

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 32;
export const DEFAULT_FONT_SIZE = 20;
export const LINE_WIDTH_MIN = 20;
export const LINE_WIDTH_MAX = 60;
export const DEFAULT_LINE_WIDTH = 34;

const THEME_VALUES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const LIGHT_BG_VALUES: readonly LightBackground[] = ['white', 'cream'];
const MODE_VALUES: readonly EditorMode[] = ['typewriter', 'centered'];

const MODIFIER_EVENT_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock',
]);

const KEY_LABELS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  space: 'Space',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

/** 检测 macOS（决定默认快捷键与修饰键符号）。 */
export function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  const ua = nav.userAgent ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad|iPod/i.test(ua);
}

/** 默认保存快捷键：Windows/Linux = Ctrl+S，macOS = ⌘S。 */
export function defaultSaveShortcut(): ShortcutBinding {
  const mac = detectMac();
  return { ctrl: !mac, alt: false, shift: false, meta: mac, key: 's' };
}

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    lightBackground: 'white',
    mode: 'typewriter',
    fontSize: DEFAULT_FONT_SIZE,
    lineWidth: DEFAULT_LINE_WIDTH,
    recordComposition: true,
    saveShortcut: defaultSaveShortcut(),
  };
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isShortcutBinding(value: unknown): value is ShortcutBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.ctrl === 'boolean' &&
    typeof binding.alt === 'boolean' &&
    typeof binding.shift === 'boolean' &&
    typeof binding.meta === 'boolean' &&
    typeof binding.key === 'string' &&
    binding.key.length > 0 &&
    binding.key.length <= 24
  );
}

/** 把任意（可能是旧版本/被手改的）持久化数据规整为合法设置。 */
export function normalizeSettings(input: unknown): AppSettings {
  const base = defaultSettings();
  if (!input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;

  const theme = THEME_VALUES.includes(raw.theme as ThemeMode) ? (raw.theme as ThemeMode) : base.theme;
  const lightBackground = LIGHT_BG_VALUES.includes(raw.lightBackground as LightBackground)
    ? (raw.lightBackground as LightBackground)
    : base.lightBackground;
  const mode = MODE_VALUES.includes(raw.mode as EditorMode) ? (raw.mode as EditorMode) : base.mode;
  const fontSize = Math.round(
    clampNumber(finiteNumber(raw.fontSize, base.fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX),
  );
  const lineWidth = Math.round(
    clampNumber(finiteNumber(raw.lineWidth, base.lineWidth), LINE_WIDTH_MIN, LINE_WIDTH_MAX),
  );
  const recordComposition = typeof raw.recordComposition === 'boolean' ? raw.recordComposition : base.recordComposition;
  const saveShortcut = isShortcutBinding(raw.saveShortcut) ? raw.saveShortcut : base.saveShortcut;

  return { theme, lightBackground, mode, fontSize, lineWidth, recordComposition, saveShortcut };
}

export function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaultSettings();
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage 不可用（隐私模式/配额满）时静默降级：本次会话内设置仍然生效 */
  }
}

/** 应用主题到 documentElement（CSS 只认 dataset，不认 React 状态）。 */
export function applyTheme(settings: Pick<AppSettings, 'theme' | 'lightBackground'>): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.lightBg = settings.lightBackground;
}

/** 归一化 KeyboardEvent.key：单字符小写，其余用可读名称。 */
export function normalizeEventKey(event: KeyboardEvent): string {
  const key = event.key ?? '';
  if (!key) return '';
  if (key === ' ' || key === 'Spacebar') return 'space';
  return key.toLowerCase();
}

/**
 * 从键盘事件生成快捷键绑定。
 * 返回 null 表示这次按键不能作为保存快捷键：纯修饰键，或缺少 Ctrl/Alt/⌘（避免普通字母抢占输入）。
 */
export function captureShortcut(event: KeyboardEvent): ShortcutBinding | null {
  if (MODIFIER_EVENT_KEYS.has(event.key)) return null;
  const key = normalizeEventKey(event);
  if (!key) return null;
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return null;
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key,
  };
}

export function matchesShortcut(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  return (
    event.ctrlKey === binding.ctrl &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift &&
    event.metaKey === binding.meta &&
    normalizeEventKey(event) === binding.key
  );
}

function formatKeyName(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** 展示用快捷键文本：macOS 用符号（⌘S），其它平台用 Ctrl+S。 */
export function formatShortcut(binding: ShortcutBinding): string {
  const mac = detectMac();
  const parts: string[] = [];
  if (binding.ctrl) parts.push(mac ? '⌃' : 'Ctrl');
  if (binding.alt) parts.push(mac ? '⌥' : 'Alt');
  if (binding.shift) parts.push(mac ? '⇧' : 'Shift');
  if (binding.meta) parts.push(mac ? '⌘' : 'Meta');
  parts.push(formatKeyName(binding.key));
  return mac ? parts.join('') : parts.join('+');
}

/**
 * 初始设置：应用是纯静态页面，在 React 渲染前先应用主题，避免首帧闪白/闪黑。
 */
export const INITIAL_SETTINGS: AppSettings = typeof window === 'undefined' ? defaultSettings() : loadSettings();

if (typeof document !== 'undefined') {
  applyTheme(INITIAL_SETTINGS);
}
