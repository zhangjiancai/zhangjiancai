/**
 * 内联 SVG 图标（全部 currentColor、无彩色）。
 * 线条风格统一：24x24 viewBox、1.5px 描边、圆角端点。
 */
import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 5 8 12l7 7" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v12M7 11l5 5 5-5" />
      <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </Svg>
  );
}

export function IconRestore(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 9a8 8 0 1 1 2.3 8.1" />
      <path d="M4 4v5h5" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </Svg>
  );
}

export function IconHistory(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 7v5l3 2" />
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3 4v4h4" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** 原始输入时间线：一条带节点的轨迹。 */
export function IconTrace(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12h18" />
      <circle cx="7" cy="12" r="1.7" />
      <circle cx="13" cy="12" r="1.7" />
      <circle cx="18" cy="12" r="1.7" />
      <path d="M7 12V8M13 12v4M18 12V9" />
    </Svg>
  );
}

/** 打字机模式：每行右端对齐。 */
export function IconAlignRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M8 10h12M6 14h14M10 18h10" />
    </Svg>
  );
}

/** 居中模式：常规左对齐排版。 */
export function IconAlignLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 10h12M4 14h14M4 18h10" />
    </Svg>
  );
}
