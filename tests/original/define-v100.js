

const fMouse=1;
const fKeyboard=2;
const fMedia=3;
const fJuji=4;
const fAdv=5;
const fCmd=6;



const fmsCLICK=1;
const fmsMENU=2;
const fmsMIDDLE=3;
const fmsFORWARD=4;
const fmsBACK=5;
const fmsDBCLICK=6;

const fmsSU=8;
const fmsSD=9;
const fmsTL=10;  
const fmsTR=11;  

const favDPI=12;
const favDPIINC=13;
const favDPIDEC=14;
const favOFF=15;
const favSNIPE=16;
const favFIRE=17;
const favProfile=18;  


const fmePLAYER=1;
const fmePLAYPAUSE=2;
const fmeSTOP=3;
const fmePREVIOUS=4;
const fmeNEXT=5;
const fmeVOLINC=6;
const fmeVOLDEC=7;
const fmeMUTE=8;
const fmeEMAIL=9;
const fmeCAL=10;
const fmeEXPLORER=11;
const fmeHOME=12;
const fmeFAVOR=13;
const fmeREFRESH=14;
const fmeFORWARD=15;
const fmeBACK=16;
const fmeSEARCH=17;




const mdfCtrlL=1
const mdfShiftL=2
const mdfAltL=4
const mdfWinL=8
const mdfCtrlR=16
const mdfShiftR=32
const mdfAltR=64
const mdfWinR=128
let i=0;
var vkPOS = new Array();

vkPOS[i++]=["KeyA", "A", 0x04];
vkPOS[i++]=["KeyB", "B", 0x05];
vkPOS[i++]=["KeyC", "C", 0x06];
vkPOS[i++]=["KeyD", "D", 0x07];
vkPOS[i++]=["KeyE", "E", 0x08];
vkPOS[i++]=["KeyF", "F", 0x09];
vkPOS[i++]=["KeyG", "G", 0x0A];
vkPOS[i++]=["KeyH", "H", 0x0B];
vkPOS[i++]=["KeyI", "I", 0x0C];
vkPOS[i++]=["KeyJ", "J", 0x0D];
vkPOS[i++]=["KeyK", "K", 0x0E];
vkPOS[i++]=["KeyL", "L", 0x0F];
vkPOS[i++]=["KeyM", "M", 0x10];
vkPOS[i++]=["KeyN", "N", 0x11];
vkPOS[i++]=["KeyO", "O", 0x12];
vkPOS[i++]=["KeyP", "P", 0x13];
vkPOS[i++]=["KeyQ", "Q", 0x14];
vkPOS[i++]=["KeyR", "R", 0x15];
vkPOS[i++]=["KeyS", "S", 0x16];
vkPOS[i++]=["KeyT", "T", 0x17];
vkPOS[i++]=["KeyU", "U", 0x18];
vkPOS[i++]=["KeyV", "V", 0x19];
vkPOS[i++]=["KeyW", "W", 0x1A];
vkPOS[i++]=["KeyX", "X", 0x1B];
vkPOS[i++]=["KeyY", "Y", 0x1C];
vkPOS[i++]=["KeyZ", "Z", 0x1D];
vkPOS[i++]=["Digit1", "1", 0x1e];
vkPOS[i++]=["Digit2", "2", 0x1f];
vkPOS[i++]=["Digit3", "3", 0x20];
vkPOS[i++]=["Digit4", "4", 0x21];
vkPOS[i++]=["Digit5", "5", 0x22];
vkPOS[i++]=["Digit6", "6", 0x23];
vkPOS[i++]=["Digit7", "7", 0x24];
vkPOS[i++]=["Digit8", "8", 0x25];
vkPOS[i++]=["Digit9", "9", 0x26];
vkPOS[i++]=["Digit0", "0", 0x27];
vkPOS[i++]=["F1", "F1", 0x3A];
vkPOS[i++]=["F2", "F2", 0x3B];
vkPOS[i++]=["F3", "F3", 0x3C];
vkPOS[i++]=["F4", "F4", 0x3D];
vkPOS[i++]=["F5", "F5", 0x3E];
vkPOS[i++]=["F6", "F6", 0x3F];
vkPOS[i++]=["F7", "F7", 0x40];
vkPOS[i++]=["F8", "F8", 0x41];
vkPOS[i++]=["F9", "F9", 0x42];
vkPOS[i++]=["F10", "F10", 0x43];
vkPOS[i++]=["F11", "F11", 0x44];
vkPOS[i++]=["F12", "F12", 0x45];
vkPOS[i++]=["F13", "F13", 0x68];  

vkPOS[i++]=["Minus", "-", 0x2D];  
vkPOS[i++]=["Equal", "=", 0x2E];  
vkPOS[i++]=["BracketLeft", "[", 0x2F];  
vkPOS[i++]=["BracketRight", "]", 0x30]; 
vkPOS[i++]=["Backslash", "|", 0x31];  
vkPOS[i++]=["Semicolon", ";", 0x33];  
vkPOS[i++]=["Quote", "'", 0x34];  
vkPOS[i++]=["Comma", "<", 0x36];  
vkPOS[i++]=["Period", ">", 0x37]; 
vkPOS[i++]=["Slash", "?", 0x38];  
vkPOS[i++]=["Backquote", "~", 0x35]; 
vkPOS[i++]=["Backspace", "Back", 0x2A];
vkPOS[i++]=["Enter", "Enter", 0x28];
vkPOS[i++]=["Space", "Space", 0x2C];
vkPOS[i++]=["Escape", "Esc", 0x29];
vkPOS[i++]=["Tab", "Tab", 0x2B];
vkPOS[i++]=["CapsLock", "CapsLk", 0x39];
vkPOS[i++]=["ContextMenu", "App", 0x65]; 
vkPOS[i++]=["ControlLeft", "Ctrl", 0xE0]; 
vkPOS[i++]=["ShiftLeft", "Shift", 0xE1];
vkPOS[i++]=["AltLeft", "Alt", 0xE2];
vkPOS[i++]=["MetaLeft", "Win", 0xE3];  
vkPOS[i++]=["ControlRight", "RCtrl", 0xE4];  
vkPOS[i++]=["ShiftRight", "RShift", 0xE5];
vkPOS[i++]=["AltRight", "RAlt", 0xE6];
vkPOS[i++]=["MetaRight", "RWin", 0xE7];  

vkPOS[i++]=["Pause", "Pause", 0x48];
vkPOS[i++]=["ScrollLock", "ScrLk", 0x47];
vkPOS[i++]=["Insert", "Ins", 0x49];
vkPOS[i++]=["Home", "Home", 0x4a];
vkPOS[i++]=["PageUp", "PgUp", 0x4b];
vkPOS[i++]=["Delete", "Del", 0x4c];
vkPOS[i++]=["End", "End", 0x4d];
vkPOS[i++]=["PageDown", "PgDn", 0x4e];
vkPOS[i++]=["ArrowLeft", "Left", 0x50];
vkPOS[i++]=["ArrowUp", "Up", 0x52];
vkPOS[i++]=["ArrowDown", "Down", 0x51];
vkPOS[i++]=["ArrowRight", "Right", 0x4f];

vkPOS[i++]=["NumLock", "NumLk", 0x53];
vkPOS[i++]=["NumpadEnter", "NumEnter", 0x58];
vkPOS[i++]=["NumpadDivide", "Num/", 0x54];  
vkPOS[i++]=["NumpadMultiply", "Num*", 0x55];  
vkPOS[i++]=["NumpadSubtract", "Num-", 0x56];  
vkPOS[i++]=["NumpadAdd", "Num+", 0x57];  
vkPOS[i++]=["NumpadDecimal", "Num.", 0x63]; 
vkPOS[i++]=["Numpad1", "Num1", 0x59];
vkPOS[i++]=["Numpad2", "Num2", 0x5a];
vkPOS[i++]=["Numpad3", "Num3", 0x5b];
vkPOS[i++]=["Numpad4", "Num4", 0x5c];
vkPOS[i++]=["Numpad5", "Num5", 0x5d];
vkPOS[i++]=["Numpad6", "Num6", 0x5e];
vkPOS[i++]=["Numpad7", "Num7", 0x5f];
vkPOS[i++]=["Numpad8", "Num8", 0x60];
vkPOS[i++]=["Numpad9", "Num9", 0x61];
vkPOS[i++]=["Numpad0", "Num0", 0x62];
vkPOS[i++]=["IntlBackslash", "K45", 0x64];  
vkPOS[i++]=["LButton", "LButton", 0xf0];   
vkPOS[i++]=["RButton", "RButton", 0xf1];
vkPOS[i++]=["MButton", "MButton", 0xf2];


function name_to_code(name){
    for(let i=0; i<vkPOS.length; i++){
        if(name==vkPOS[i][0]) return vkPOS[i][2];
    }
    return 0;
}
function keyname_to_code(name){
    for(let i=0; i<vkPOS.length; i++){
        if(name==vkPOS[i][1]) return vkPOS[i][2];
    }
    return 0;
}
function code_to_keyname(code){
    for(let i=0; i<vkPOS.length; i++){
        if(code==vkPOS[i][2]) return vkPOS[i][1];
    }
    return "";
}
function name_to_keyname(name){   
    for(let i=0; i<vkPOS.length; i++){
        if(name==vkPOS[i][0]) return vkPOS[i][1];
    }
    return '';
}
