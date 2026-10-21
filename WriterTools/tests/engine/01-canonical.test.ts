import { describe, expect, it } from 'vitest';
import { canonicalJson, hashText, sha256Utf8Hex } from '../../src/engine/canonical';
import { createHeaderEvent, serializeEvents } from '../../src/engine/log';
import { checkLogText, testCanonicalJson, testHashEvent } from '../support/test-utils';

const SAMPLES: unknown[] = [
  null,
  true,
  false,
  0,
  -42,
  9007199254740991,
  '',
  'hello',
  '你好，世界',
  '😀 emoji',
  'quote:" backslash:\\ newline:\n tab:\t',
  [],
  [1, 'a', null, { z: 1 }],
  {},
  { b: 1, a: 2 },
  { z: { y: [3, 2, 1], x: { n: null } }, a: [{ b: 2, a: 1 }] },
  { '': 'empty-key', 'a b': 1, '\n': 2 },
];

describe('规范化 JSON（规范 4.1）', () => {
  it('与测试内独立实现逐字节一致', () => {
    for (const sample of SAMPLES) {
      expect(canonicalJson(sample)).toBe(testCanonicalJson(sample));
    }
  });

  it('递归键排序、无任何空白', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('字符串转义与 JSON.stringify 完全一致（含孤立代理项）', () => {
    const strings = ['"', '\\', '\n', '\r', '\t', '\u0000', '\u001f', '😀', 'a\u2028b', '\ud800', '\udc00', 'héllo', ''];
    for (const value of strings) expect(canonicalJson(value)).toBe(JSON.stringify(value));
  });

  it('拒绝 undefined / NaN / Infinity / 浮点数（规范 4.1.5）', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson(1.5)).toThrow();
  });

  it('数组保持原顺序', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('SHA-256 与文本哈希（规范 4.2）', () => {
  it('固定输入得到固定哈希（SHA-256 已知向量）', async () => {
    expect(await sha256Utf8Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashText('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await hashText('你好')).toBe(`sha256:${await sha256Utf8Hex('你好')}`);
    expect(await hashText('😀')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('固定 header 事件哈希可被独立实现复算且确定', async () => {
    const first = await createHeaderEvent({
      docId: '0f4c9a2e-6b1d-4c8a-9f0e-2a7b3c5d8e11',
      title: '无题',
      createdAt: '2026-10-20T15:32:00.000Z',
      ts: '2026-10-20T15:32:00.000Z',
      id: 'e0b6f0c1-4f4e-4b8f-9d6a-1c2d3e4f5a60',
    });
    const second = await createHeaderEvent({
      docId: '0f4c9a2e-6b1d-4c8a-9f0e-2a7b3c5d8e11',
      title: '无题',
      createdAt: '2026-10-20T15:32:00.000Z',
      ts: '2026-10-20T15:32:00.000Z',
      id: 'e0b6f0c1-4f4e-4b8f-9d6a-1c2d3e4f5a60',
    });
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await testHashEvent(first as unknown as Record<string, unknown>)).toBe(first.hash);
    // 写出行就是规范化 JSON
    expect(serializeEvents([first])).toBe(`${testCanonicalJson(first)}\n`);
    await checkLogText(serializeEvents([first]));
  });
});
