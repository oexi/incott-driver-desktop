// 按键码编解码：hwToKey 必须是 keyToHw 的逆运算（首次连接时用来还原鼠标现有映射）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/protocol/constants.js';
import { keyToHw, hwToKey } from '../src/protocol/device.js';
import { vkPOS } from '../src/protocol/keytable.js';

const roundTrip = (k) => {
  const back = hwToKey(keyToHw(k, 0));
  assert.ok(back, `无法还原 ${k.toText()}`);
  assert.equal(back.toText(), k.toText());
};

test('鼠标功能', () => {
  for (const m of [C.fmsCLICK, C.fmsMENU, C.fmsMIDDLE, C.fmsFORWARD, C.fmsBACK, C.favDPI, C.favDPIINC, C.favDPIDEC, C.favProfile, C.favOFF]) {
    roundTrip(new C.KeyInfo(C.fMouse, m));
  }
});

test('多媒体', () => {
  for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17]) roundTrip(new C.KeyInfo(C.fMedia, m));
});

test('键盘与组合键', () => {
  for (const [, , hid] of vkPOS) {
    roundTrip(new C.KeyInfo(C.fKeyboard, hid));
    const k = new C.KeyInfo(C.fKeyboard, hid);
    k.modifer = C.mdfCtrlL | C.mdfAltL;
    roundTrip(k);
  }
});

test('真实鼠标读回的默认映射', () => {
  // 来自 G23V2 实测：矩阵 0..5
  const codes = [0x00f00001, 0x00f10001, 0x00f20001, 0x00f30001, 0x00f40001, 0x00030007];
  const names = codes.map((c) => hwToKey(c).toText());
  assert.deepEqual(names, ['1,1,0,0,0', '1,2,0,0,0', '1,3,0,0,0', '1,5,0,0,0', '1,4,0,0,0', '1,12,0,0,0']);
});

test('宏 / 火力键无法还原', () => {
  assert.equal(hwToKey((3 << 16) | 9), null);
  assert.equal(hwToKey(0x0218f00a), null);
});
