/**
 * 光标行垂直居中
 * ==============
 * textarea 铺满内容区，用 padding-top/bottom 预留半屏空间；再用一个与原 textarea
 * 同字体、同宽度、同行高、同换行规则的镜像 div，在光标位置插入零宽标记，
 * 量出光标所在行的 offsetTop，最后令
 *
 *   scrollTop = paddingTop + caretTop - (clientHeight - lineHeight) / 2
 *
 * 并做 clamp。这样无论文档多长，光标所在行永远在可视区垂直中央。
 * 打字机模式与居中模式共用同一套纵向逻辑（横向对齐由 CSS text-align 决定）。
 */

const CARET_MARKER_CLASS = 'editor-mirror-caret';

export interface CenteringOptions {
  textarea: HTMLTextAreaElement;
  mirror: HTMLElement;
}

function getCaretOffset(textarea: HTMLTextAreaElement): number {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const offset = start === end ? end : textarea.selectionDirection === 'backward' ? start : end;
  return Math.min(Math.max(0, offset), textarea.value.length);
}

export class CaretCentering {
  private readonly textarea: HTMLTextAreaElement;
  private readonly mirror: HTMLElement;
  private frame = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: CenteringOptions) {
    this.textarea = options.textarea;
    this.mirror = options.mirror;
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.textarea);
    }
  }

  private onResize = (): void => {
    this.schedule();
  };

  /** 请求在下一帧重新居中（同一帧内多次调用只执行一次）。 */
  schedule = (): void => {
    if (this.disposed) return;
    if (this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.center();
    });
  };

  /** 立即居中（用于布局稳定后的补充调用）。 */
  center = (): void => {
    this.performCenter();
  };

  private performCenter(): void {
    if (this.disposed) return;
    const textarea = this.textarea;
    if (!textarea.isConnected) return;
    const height = textarea.clientHeight;
    const width = textarea.clientWidth;
    if (height <= 0 || width <= 0) return;

    const computed = window.getComputedStyle(textarea);
    let lineHeight = Number.parseFloat(computed.lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
      lineHeight = (Number.parseFloat(computed.fontSize) || 20) * 1.65;
    }

    // 上下各留出"半屏 - 半行"，使首行/末行也能居中。
    const padding = Math.max(lineHeight, (height - lineHeight) / 2);
    const currentPadding = Number.parseFloat(textarea.style.paddingTop || '0');
    if (!Number.isFinite(currentPadding) || Math.abs(currentPadding - padding) > 0.5) {
      textarea.style.paddingTop = `${padding}px`;
      textarea.style.paddingBottom = `${padding}px`;
    }

    const mirror = this.mirror;
    mirror.style.boxSizing = 'border-box';
    mirror.style.width = `${width}px`;
    mirror.style.fontFamily = computed.fontFamily;
    mirror.style.fontSize = computed.fontSize;
    mirror.style.fontWeight = computed.fontWeight;
    mirror.style.fontStyle = computed.fontStyle;
    mirror.style.lineHeight = computed.lineHeight;
    mirror.style.letterSpacing = computed.letterSpacing;
    mirror.style.wordSpacing = computed.wordSpacing;
    mirror.style.tabSize = computed.tabSize;
    mirror.style.paddingLeft = computed.paddingLeft;
    mirror.style.paddingRight = computed.paddingRight;

    const caretOffset = getCaretOffset(textarea);
    const text = textarea.value;
    mirror.textContent = '';

    const marker = document.createElement('span');
    marker.className = CARET_MARKER_CLASS;
    marker.style.height = `${lineHeight}px`;

    mirror.append(
      document.createTextNode(text.slice(0, caretOffset)),
      marker,
      document.createTextNode(text.slice(caretOffset)),
    );

    const caretTop = marker.offsetTop;
    const target = padding + caretTop - (height - lineHeight) / 2;
    const maxScroll = Math.max(0, textarea.scrollHeight - height);
    const nextScroll = Math.min(Math.max(0, Math.round(target)), maxScroll);
    if (Math.abs(textarea.scrollTop - nextScroll) > 1) {
      textarea.scrollTop = nextScroll;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }
}
