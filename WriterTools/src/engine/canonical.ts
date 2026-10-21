/**
 * 规范化 JSON（Canonical JSON）与 SHA-256 哈希工具。
 *
 * 规范见 docs/FILE-FORMAT.md 第 4 节：
 * - 对象键按 UTF-16 码元顺序递归升序；数组保持顺序；
 * - 无任何多余空白；
 * - 字符串转义与 ECMAScript JSON.stringify(string) 完全一致（含孤立代理项）；
 * - 值域：字符串、布尔、null、整数、对象、数组（不支持 undefined/NaN/Infinity）。
 */

const HEX = '0123456789abcdef';

/** 不允许出现在规范化 JSON 中的值（undefined / 函数 / symbol / 非整数数字等）。 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/** 将任意受支持的值序列化为规范 JSON 字符串（无空白、键递归排序）。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      // JSON.stringify 对字符串的转义（含孤立代理项）正是规范要求的行为。
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError('规范化 JSON 不支持 NaN/Infinity（规范 4.1.5）');
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalJsonError('规范化 JSON 只支持整数（规范 4.1.4）');
      }
      return String(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value) parts.push(canonicalJson(item));
        return `[${parts.join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      for (const key of keys) {
        if (record[key] === undefined) {
          throw new CanonicalJsonError(`规范化 JSON 不允许 undefined 值（键 "${key}"，规范 4.1.5）`);
        }
      }
      keys.sort(); // 默认序 = UTF-16 码元顺序（规范 4.1.1）
      const parts: string[] = [];
      for (const key of keys) parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`规范化 JSON 不支持的类型：${typeof value}（规范 4.1.5）`);
  }
}

/** 把字节数组转成小写十六进制。 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    out += HEX[byte >>> 4] + HEX[byte & 0x0f];
  }
  return out;
}

let subtleCache: SubtleCrypto | null = null;

function getSubtle(): SubtleCrypto {
  if (subtleCache) return subtleCache;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境缺少 WebCrypto（window.crypto.subtle），无法计算哈希');
  subtleCache = subtle;
  return subtle;
}

/** SHA-256(UTF-8 字节) 的小写十六进制。 */
export async function sha256Utf8Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await getSubtle().digest('SHA-256', bytes as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** SHA-256(原始字节) 的小写十六进制。 */
export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await getSubtle().digest('SHA-256', bytes as unknown as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** 文件格式中的文本哈希：`sha256:<hex>`（对 UTF-8 字节取 SHA-256）。 */
export async function hashText(text: string): Promise<string> {
  return `sha256:${await sha256Utf8Hex(text)}`;
}

/**
 * 计算事件哈希：删除顶层 `hash` 字段后做规范化 JSON，再对 UTF-8 字节取 SHA-256。
 * 其余字段（含 prev、未知字段）全部参与计算（规范 4.2）。
 */
export async function computeEventHash(event: Record<string, unknown>): Promise<string> {
  const { hash: _ignoredHash, ...withoutHash } = event;
  const canonical = canonicalJson(withoutHash);
  return `sha256:${await sha256Utf8Hex(canonical)}`;
}
