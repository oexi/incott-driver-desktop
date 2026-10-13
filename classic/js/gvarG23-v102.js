function initgvarG23(v){  
    

    
    
    v.key = new Array(6);
    v.key[0] = new KeyInfo(fMouse, fmsCLICK); v.key[0].matrix=0;
    v.key[1] = new KeyInfo(fMouse, fmsMENU); v.key[1].matrix=1;
    v.key[2] = new KeyInfo(fMouse, fmsMIDDLE); v.key[2].matrix=2;
    v.key[3] = new KeyInfo(fMouse, fmsFORWARD); v.key[3].matrix=4;
    v.key[4] = new KeyInfo(fMouse, fmsBACK); v.key[4].matrix=3;
    v.key[5] = new KeyInfo(fMouse, favDPI); v.key[5].matrix=5;
    
    

    v.lodUI = [0.7, 1, 2];
    v.lodHW = [0, 1, 2];


    
    v.stDPI = new Array(2);  
    let ix=0;
    v.stDPI[ix] = new Object();
    v.stDPI[ix].sensor = 0x3395;
    v.stDPI[ix].defDPIInx = 1;   
    v.stDPI[ix].dpicolor = new Array(6);
    v.stDPI[ix].dpicolor[0] = rgb(255,0,0);
    v.stDPI[ix].dpicolor[1] = rgb(0,0,255);
    v.stDPI[ix].dpicolor[2] = rgb(0,255,0);
    v.stDPI[ix].dpicolor[3] = rgb(255,255,0);
    v.stDPI[ix].dpicolor[4] = rgb(0,255,255);
    v.stDPI[ix].dpicolor[5] = rgb(255,0,255);
    v.stDPI[ix].dpi = [400, 800, 1600, 2400, 3200, 6400];
    v.stDPI[ix].dpiUI = new Array();
    v.stDPI[ix].dpiHW = new Array();
    
    i=0, val=50, hw=0, uistep=50, hwstep=1;
    while(1){   
        if(val>32000) break;
        v.stDPI[ix].dpiUI[i]=val;
        v.stDPI[ix].dpiHW[i]=hw;
        val += uistep;
        hw += hwstep;   
        i++;
    }

    ix++;
    v.stDPI[ix] = new Object();
    v.stDPI[ix].sensor = 0x3950;
    v.stDPI[ix].defDPIInx = 1;   
    v.stDPI[ix].dpicolor = new Array(6);
    v.stDPI[ix].dpicolor[0] = rgb(255,0,0);
    v.stDPI[ix].dpicolor[1] = rgb(0,0,255);
    v.stDPI[ix].dpicolor[2] = rgb(0,255,0);
    v.stDPI[ix].dpicolor[3] = rgb(255,255,0);
    v.stDPI[ix].dpicolor[4] = rgb(0,255,255);
    v.stDPI[ix].dpicolor[5] = rgb(255,0,255);
    v.stDPI[ix].dpi = [400, 800, 1600, 2400, 3200, 6400];
    v.stDPI[ix].dpiUI = new Array();
    v.stDPI[ix].dpiHW = new Array();
    
    i=0, val=50, hw=0;
    while(1){   
        if(val>45000) break;
        v.stDPI[ix].dpiUI[i]=val;
        v.stDPI[ix].dpiHW[i]=hw;
        val += uistep;
        hw += hwstep;   
        i++;
    }
}

function getStDPI(sensor){
    for(let i=0; i<dvar.stDPI.length; i++){
        if(dvar.stDPI[i].sensor==sensor) return dvar.stDPI[i];
    }
    return null;
}

function getHwForDpi(dpi, sensor){
    let stDPI = getStDPI(sensor);
    for(let i=0; i<stDPI.dpiUI.length; i++){
        if(dpi==stDPI.dpiUI[i]) return stDPI.dpiHW[i];
    }
    return -1;
};