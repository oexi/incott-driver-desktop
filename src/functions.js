// 按键功能目录与显示名（对应原版 funList_Init / keyinfo_to_string）

import * as C from './protocol/constants.js';
import { hidToKeyname } from './protocol/keytable.js';

export const MOUSE_FUNCS = [
  [C.fmsCLICK, 'click'],
  [C.fmsMENU, 'menu'],
  [C.fmsMIDDLE, 'mid'],
  [C.fmsFORWARD, 'forward'],
  [C.fmsBACK, 'back'],
  [C.favDPI, 'dpi'],
  [C.favDPIINC, 'dpiInc'],
  [C.favDPIDEC, 'dpiDec'],
  [C.favProfile, 'profile'],
  [C.favOFF, 'off'],
];

export const MEDIA_FUNCS = [
  [C.fmePLAYER, 'media1'],
  [C.fmePLAYPAUSE, 'media2'],
  [C.fmeSTOP, 'media3'],
  [C.fmePREVIOUS, 'media4'],
  [C.fmeNEXT, 'media5'],
  [C.fmeVOLINC, 'media6'],
  [C.fmeVOLDEC, 'media7'],
  [C.fmeMUTE, 'media8'],
  [C.fmeEMAIL, 'media10'],
  [C.fmeCAL, 'media9'],
  [C.fmeEXPLORER, 'media12'],
  [C.fmeHOME, 'media11'],
  [C.fmeREFRESH, 'media14'],
  [C.fmeFORWARD, 'media17'],
  [C.fmeBACK, 'media18'],
  [C.fmeSEARCH, 'media15'],
];

const MOD_NAMES = [
  [C.mdfCtrlL, 'Ctrl'],
  [C.mdfShiftL, 'Shift'],
  [C.mdfAltL, 'Alt'],
  [C.mdfWinL, 'Win'],
  [C.mdfCtrlR, 'RCtrl'],
  [C.mdfShiftR, 'RShift'],
  [C.mdfAltR, 'RAlt'],
  [C.mdfWinR, 'RWin'],
];

export function modifierNames(mod) {
  return MOD_NAMES.filter(([m]) => mod & m).map(([, n]) => n);
}

/** KeyInfo → 显示文字 */
export function keyLabel(kf, t, macros) {
  if (!kf) return '';
  if (kf.major === C.fKeyboard) {
    const parts = modifierNames(kf.modifer);
    const k = hidToKeyname(kf.minor);
    if (k) parts.push(k);
    return parts.join(' + ');
  }
  if (kf.major === C.fMouse) {
    if (kf.minor === C.favFIRE) {
      const count = kf.itemdata & 65535;
      const interval = (kf.itemdata >> 16) & 65535;
      return `${t.fn.fire} · ${interval}ms × ${count || '∞'}`;
    }
    const f = MOUSE_FUNCS.find(([m]) => m === kf.minor);
    return f ? t.fn[f[1]] : '';
  }
  if (kf.major === C.fMedia) {
    const f = MEDIA_FUNCS.find(([m]) => m === kf.minor);
    return f ? t.fn[f[1]] : '';
  }
  if (kf.major === C.fJuji) {
    const m = macros && macros.find(kf.itemdata);
    return m ? `${t.fn.macro} · ${m.name}` : t.fn.macro;
  }
  return '';
}

/** 功能类别，用于图标与颜色 */
export function keyCategory(kf) {
  if (!kf) return 'mouse';
  if (kf.major === C.fKeyboard) return kf.modifer ? 'combo' : 'keyboard';
  if (kf.major === C.fMedia) return 'media';
  if (kf.major === C.fJuji) return 'macro';
  if (kf.major === C.fMouse && kf.minor === C.favFIRE) return 'fire';
  return 'mouse';
}

/** 键盘页分组（基于原版按键表的顺序） */
export function keyboardGroups(vk) {
  const groups = [
    { id: 'letters', zh: '字母', en: 'Letters', test: (c) => /^Key[A-Z]$/.test(c) },
    { id: 'digits', zh: '数字', en: 'Digits', test: (c) => /^Digit\d$/.test(c) },
    { id: 'fn', zh: '功能键', en: 'Function', test: (c) => /^F\d+$/.test(c) },
    {
      id: 'symbols',
      zh: '符号',
      en: 'Symbols',
      test: (c) => ['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote', 'IntlBackslash'].includes(c),
    },
    {
      id: 'edit',
      zh: '编辑与控制',
      en: 'Editing & control',
      test: (c) =>
        ['Backspace', 'Enter', 'Space', 'Escape', 'Tab', 'CapsLock', 'ContextMenu', 'Pause', 'ScrollLock', 'Insert', 'Home', 'PageUp', 'Delete', 'End', 'PageDown'].includes(c),
    },
    { id: 'arrows', zh: '方向键', en: 'Arrows', test: (c) => /^Arrow/.test(c) },
    { id: 'mods', zh: '修饰键', en: 'Modifiers', test: (c) => /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(c) },
    { id: 'numpad', zh: '小键盘', en: 'Numpad', test: (c) => /^Num/.test(c) },
  ];
  return groups.map((g) => ({ ...g, keys: vk.filter(([c]) => g.test(c) && !/Button$/.test(c)) }));
}
