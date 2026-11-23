// 물 표면, 커스틱, 굴절 렌더링
// 수면 물결과 커스틱 계산은 아래 코드를 WebGL2로 옮겨 고친 것이다.
//
// WebGL Water - https://github.com/evanw/webgl-water
// Copyright 2011 Evan Wallace
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
// EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
// THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// 수조 안 잉크와 수온은 fluid.js의 3D 유체 계산 결과를 광선 추적으로 그린다.
(function () {
  'use strict';
  const QUAD = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform sampler2D uTex; uniform vec2 uSize; out vec4 o;
  vec4 at(ivec2 p){ return texelFetch(uTex, clamp(p, ivec2(0), ivec2(uSize)-1), 0); }
  `;
  // 수면 높이장: (높이, 속도, 법선 x, 법선 z), 높이 단위 cm
  const WAVE_DROP = QUAD + `
  uniform vec2 uCenter; uniform float uRadius, uStrength;
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy); vec4 info = at(p);
    vec2 pos = gl_FragCoord.xy/uSize*vec2(30.0,20.0);
    float d = max(0.0, 1.0-length(pos-uCenter)/uRadius);
    info.r += (0.5-cos(d*3.14159265)*0.5)*uStrength;
    o = info;
  }`;
  const WAVE_UPDATE = QUAD + `
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy); vec4 info = at(p);
    float avg = (at(p-ivec2(1,0)).r + at(p+ivec2(1,0)).r + at(p-ivec2(0,1)).r + at(p+ivec2(0,1)).r)*0.25;
    info.g += (avg-info.r)*2.0; info.g *= 0.993; info.r += info.g;
    o = info;
  }`;
  const WAVE_NORMAL = QUAD + `
  uniform float uCell;
  void main(){
    ivec2 p = ivec2(gl_FragCoord.xy); vec4 info = at(p);
    vec3 dx = vec3(uCell, at(p+ivec2(1,0)).r-info.r, 0.0);
    vec3 dz = vec3(0.0, at(p+ivec2(0,1)).r-info.r, uCell);
    info.ba = normalize(cross(dz,dx)).xz;
    o = info;
  }`;
  // 커스틱: 굴절된 빛이 바닥에 닿을 때 삼각형이 작아지면 밝아진다.
  const CAUSTIC_VS = `#version 300 es
  precision highp float; precision highp sampler2D;
  uniform sampler2D uWave; uniform int uCols, uRows; uniform vec3 uLight; uniform vec4 uMap;
  out vec3 vOld, vNew;
  void main(){
    vec2 g = vec2(gl_VertexID % uCols, gl_VertexID / uCols)/vec2(uCols-1, uRows-1);
    vec4 info = textureLod(uWave, g, 0.0); info.ba *= 0.5;
    vec3 n = vec3(info.b, sqrt(1.0-dot(info.ba,info.ba)), info.a);
    vec3 rl = refract(-uLight, vec3(0,1,0), 1.0/1.333);
    vec3 ray = refract(-uLight, n, 1.0/1.333);
    vec3 p0 = vec3(g.x*30.0, 20.0, g.y*20.0), p1 = p0 + vec3(0.0, info.r*8.0, 0.0);
    vOld = p0 + rl*(-p0.y/rl.y); vNew = p1 + ray*(-p1.y/ray.y);
    gl_Position = vec4((vNew.xz-uMap.xy)/uMap.zw*2.0-1.0, 0.0, 1.0);
  }`;
  const CAUSTIC_FS = `#version 300 es
  precision highp float; in vec3 vOld, vNew; out vec4 o;
  void main(){
    float a0 = length(dFdx(vOld))*length(dFdy(vOld)), a1 = length(dFdx(vNew))*length(dFdy(vNew));
    o = vec4(a0/max(a1,1e-6)*0.2, 0.0, 0.0, 1.0);
  }`;

  const RENDER = `#version 300 es
  precision highp float; precision highp sampler3D; precision highp sampler2D;
  uniform sampler3D uVol, uVel3; uniform sampler2D uWave, uCaustic; uniform float uSpdMax;
  uniform vec2 uRes, uShift; uniform vec3 uCamPos, uCamR, uCamU, uCamF, uLight;
  uniform float uTan, uAspect; uniform vec4 uCup, uMap; uniform float uCupTop;
  uniform int uMode, uView, uIce, uSlice; uniform float uT0, uSliceZ, uDensMax, uInkK;
  uniform vec4 uFoam[8]; // 스티로폼 조각: x, z, 회전각, 쓰는지(1/0)
  out vec4 o;
  const float IOR = 1.333;
  const vec3 BOX = vec3(30.0,20.0,20.0);
  const vec3 GLO = vec3(-0.4,-0.4,-0.4), GHI = vec3(30.4,22.0,20.4);
  // 스티로폼 조각과의 교차: 가장 가까운 거리와 법선
  float foamHit(vec3 ro, vec3 rd, out vec3 fn){
    float best = 1e9; fn = vec3(0.0,1.0,0.0);
    for(int i=0;i<8;i++){
      vec4 f = uFoam[i]; if(f.w < 0.5) continue;
      float c = cos(f.z), s = sin(f.z);
      vec3 o = ro - vec3(f.x, 20.05, f.y);
      vec3 lo = vec3(c*o.x + s*o.z, o.y, -s*o.x + c*o.z), ld = vec3(c*rd.x + s*rd.z, rd.y, -s*rd.x + c*rd.z);
      vec3 hs = vec3(0.85 + 0.25*fract(float(i)*0.37), 0.22, 0.55 + 0.2*fract(float(i)*0.61));
      vec3 inv = 1.0/ld, a = (-hs-lo)*inv, b = (hs-lo)*inv, n = min(a,b), m = max(a,b);
      float t0 = max(max(n.x,n.y),n.z), t1 = min(min(m.x,m.y),m.z);
      if(t0 < t1 && t0 > 1e-3 && t0 < best){
        best = t0;
        vec3 ln = n.x >= n.y && n.x >= n.z ? vec3(-sign(ld.x),0.0,0.0) : n.y >= n.z ? vec3(0.0,-sign(ld.y),0.0) : vec3(0.0,0.0,-sign(ld.z));
        fn = vec3(c*ln.x - s*ln.z, ln.y, s*ln.x + c*ln.z);
      }
    }
    return best;
  }
  vec2 boxHit(vec3 ro, vec3 rd, vec3 lo, vec3 hi){
    vec3 inv = 1.0/rd; vec3 a=(lo-ro)*inv, b=(hi-ro)*inv;
    vec3 n=min(a,b), f=max(a,b); return vec2(max(max(n.x,n.y),n.z), min(min(f.x,f.y),f.z));
  }
  float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x), mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y); }
  float soft(float x, float a, float b, float e){ return smoothstep(a-e, a+e, x)*(1.0-smoothstep(b-e, b+e, x)); }
  // 주변 환경: 방 안 밝기, 앞쪽 소프트박스 조명, 천장 조명판
  vec3 sky(vec3 rd){
    vec3 c = mix(vec3(0.62,0.64,0.65), vec3(0.86,0.87,0.86), clamp(rd.y*1.3+0.3,0.0,1.0));
    if(rd.z > 0.05){ vec2 q = rd.xy/rd.z;
      c += vec3(1.0,0.98,0.95)*0.55*soft(q.x,-1.1,-0.35,0.08)*soft(q.y,0.05,0.9,0.08); }
    if(rd.y > 0.2){ vec2 q = rd.xz/rd.y;
      c += vec3(1.0,0.99,0.96)*0.7*soft(q.x,-0.7,0.1,0.06)*soft(q.y,-0.2,0.5,0.06); }
    return c + vec3(1.0,0.97,0.92)*pow(max(dot(rd,uLight),0.0),400.0)*1.5;
  }
  vec3 heat(float u){
    u = clamp(u, 0.0, 1.0);
    vec3 c0 = vec3(0.19,0.33,0.80), c1 = vec3(0.20,0.66,0.90), c2 = vec3(0.30,0.76,0.42);
    vec3 c3 = vec3(0.97,0.86,0.28), c4 = vec3(0.96,0.52,0.17), c5 = vec3(0.78,0.10,0.10);
    float x = u*5.0;
    if(x < 1.0) return mix(c0, c1, x);
    if(x < 2.0) return mix(c1, c2, x-1.0);
    if(x < 3.0) return mix(c2, c3, x-2.0);
    if(x < 4.0) return mix(c3, c4, x-3.0);
    return mix(c4, c5, x-4.0);
  }
  vec3 wood(vec2 q){
    float plank = floor(q.y/16.0);
    vec2 w = q + vec2(hash(vec2(plank, 3.0))*40.0, 0.0);
    float n = vnoise(w*vec2(0.035,0.5))*0.65 + vnoise(w*vec2(0.12,1.8))*0.35;
    float g = 0.5 + 0.5*sin((w.y + n*5.0)*2.6 + vnoise(w*vec2(0.02,0.2))*9.0);
    vec3 c = mix(vec3(0.60,0.42,0.27), vec3(0.79,0.62,0.44), n*0.7 + 0.3*hash(vec2(plank, 7.0)));
    c *= 0.88 + 0.12*g;
    float f = fract(q.y/16.0); c *= 0.80 + 0.20*smoothstep(0.0, 0.008, f)*smoothstep(1.0, 0.992, f);
    return c;
  }
  vec3 refRl(){ return refract(-uLight, vec3(0.0,1.0,0.0), 1.0/IOR); }
  float caustic(vec3 q){
    vec3 rl = refRl(); vec2 f = q.xz - rl.xz*q.y/rl.y;
    return textureLod(uCaustic, (f-uMap.xy)/uMap.zw, 0.0).r;
  }
  // 수조 밖: 실험실. 검은 에폭시 실험대, 흰 타일 벽, 시약병 선반, 아래 수납장
  const vec3 TLO = vec3(-70.0,-3.4,-30.0), THI = vec3(100.0,-0.4,38.0);
  const float WALLZ = -12.0, SHY = 42.0;
  float spotL(vec3 p){ return exp(-dot(p-vec3(15.0,14.0,0.0), p-vec3(15.0,14.0,0.0))/7000.0); }
  vec3 tiles(vec3 p, bool thru){
    vec2 q = vec2(p.x, p.y+0.4)/vec2(10.0,5.0);
    q.x += 0.5*mod(floor(q.y),2.0);
    vec2 f = fract(q), id = floor(q);
    vec3 c = vec3(0.93,0.94,0.93)*(0.97+0.03*hash(id));
    if(!thru){
      vec2 e = min(f, 1.0-f)*vec2(10.0,5.0);
      float g = min(e.x, e.y);
      c *= 0.90 + 0.10*smoothstep(0.0, 0.9, g);
      c = mix(vec3(0.78,0.79,0.78), c, smoothstep(0.07, 0.17, g));
    }
    return c;
  }
  vec3 bottle(vec2 q, out float a){
    a = 0.0; vec3 c = vec3(0.0);
    for(int i=0;i<7;i++){
      float fi = float(i);
      float x0 = -46.0 + fi*15.0 + hash(vec2(fi,1.0))*5.0;
      float w = 2.4 + hash(vec2(fi,2.0))*1.4, h = 7.0 + hash(vec2(fi,3.0))*5.0;
      float k = hash(vec2(fi,4.0));
      vec3 col = k < 0.3 ? vec3(0.55,0.30,0.10) : k < 0.55 ? vec3(0.78,0.84,0.86) : k < 0.8 ? vec3(0.22,0.38,0.62) : vec3(0.92,0.92,0.90);
      vec2 d = q - vec2(x0, SHY+1.2);
      float body = smoothstep(0.35,0.0, max(abs(d.x)-w, max(-d.y, d.y-h)));
      float neck = smoothstep(0.25,0.0, max(abs(d.x)-w*0.42, max(-(d.y-h), d.y-h-2.2)));
      float cap = smoothstep(0.2,0.0, max(abs(d.x)-w*0.5, max(-(d.y-h-2.2), d.y-h-3.4)));
      float m = max(body, neck);
      vec3 bc = col*(0.75+0.35*smoothstep(-w, w*0.3, d.x)) + 0.25*smoothstep(0.5,0.0,abs(d.x+w*0.45))*body;
      if(cap > 0.01){ c = mix(c, vec3(0.12,0.13,0.15), cap); a = max(a, cap); }
      if(m > 0.01){ c = mix(c, bc, m*(1.0-cap)); a = max(a, m); }
    }
    return c;
  }
  vec3 wallAt(vec3 p, bool thru){
    vec3 c = tiles(p, thru);
    if(p.y > SHY-0.6 && p.y < SHY+18.0){ float a; vec3 bc = bottle(p.xy, a); c = mix(c, bc, a*0.95); }
    if(p.y > SHY-1.2 && p.y < SHY){ c = vec3(0.86,0.85,0.82)*(0.8+0.2*smoothstep(SHY-1.2,SHY,p.y)); }
    float lit = 0.62 + 0.45*spotL(p);
    lit *= 0.78 + 0.22*smoothstep(0.0, 6.0, p.y);
    lit *= 1.0 - 0.18*smoothstep(4.0, 0.0, p.y-SHY+1.2)*step(p.y, SHY-1.2)*0.0;
    if(p.y < SHY-1.2 && p.y > SHY-8.0) lit *= 0.86 + 0.14*smoothstep(SHY-1.6, SHY-8.0, p.y);
    return c*lit;
  }
  vec3 labFar(vec3 rd){
    vec3 c = mix(vec3(0.86,0.875,0.88), vec3(0.97,0.975,0.975), smoothstep(-0.1, 0.5, rd.y));
    if(rd.y > 0.15){ vec2 q = rd.xz/rd.y; c += vec3(0.04)*soft(fract(q.x*0.6),0.15,0.85,0.08)*soft(q.y,-1.5,1.0,0.3); }
    return c;
  }
  vec3 background(vec3 ro, vec3 rd, bool thru){
    // 물을 통과해 보이는 뒤쪽은 무늬 없이 밝고 고르게 (가로줄·띠가 생기지 않게)
    if(thru) return (uView != 0 ? vec3(0.50,0.53,0.56) : vec3(0.70,0.74,0.76))*(0.88+0.12*clamp(rd.y+0.6,0.0,1.0));
    float tw = 1e9;
    vec2 tb = boxHit(ro, rd, TLO, THI);
    bool counter = tb.x < tb.y && tb.x > 0.0 && tb.x < tw;
    if(counter){
      vec3 p = ro+rd*tb.x;
      if(p.y > THI.y-1e-3){
        // 검은 에폭시 상판: 잔 반점, 은은한 광택에 벽이 비친다
        vec3 c = vec3(0.075,0.08,0.085);
        if(!thru) c += (hash(floor(p.xz*9.0))-0.5)*0.025 + (vnoise(p.xz*0.4)-0.5)*0.02;
        c *= 0.75 + 0.6*spotL(p);
        vec2 q = max(vec2(0.0), abs(p.xz-vec2(15.0,10.0))-vec2(15.4,10.4));
        float ao = 0.45 + 0.55*smoothstep(0.0, 3.0, length(q));
        c *= ao;
                vec3 r = reflect(rd, vec3(0.0,1.0,0.0));
        vec3 rc = labFar(r);
        if(length(q) < 0.01) rc *= 0.3;
        float fr = 0.05 + 0.6*pow(1.0-abs(rd.y), 5.0);
        c = mix(c, rc, fr*ao);
        return mix(c, labFar(rd)*0.9, smoothstep(45.0, 110.0, length(p.xz-vec2(15.0,10.0))));
      }
      // 상판 앞 모서리
      float hl = smoothstep(THI.y-0.6, THI.y, p.y);
      return vec3(0.06,0.065,0.07) + vec3(0.25)*hl*0.5;
    }
    // 실험대 아래 수납장
    float tf = rd.z < 0.0 ? (THI.z-ro.z)/rd.z : 1e9;
    if(tf > 0.0 && tf < 1e8){
      vec3 p = ro+rd*tf;
      if(p.y < TLO.y && p.y > -90.0){
        vec3 c = vec3(0.90,0.91,0.91)*(0.72+0.22*smoothstep(-60.0,-4.0,p.y));
        float gx = abs(fract((p.x+70.0)/45.0)-0.5)*45.0, gy = abs(p.y-TLO.y-1.5);
        if(!thru) c *= 0.75 + 0.25*smoothstep(0.0,0.3,gx)*smoothstep(0.0,0.3,gy);
        if(!thru && abs(fract((p.x+70.0)/45.0)-0.82)*45.0 < 0.5 && p.y < TLO.y-4.0 && p.y > TLO.y-14.0) c = vec3(0.55,0.57,0.58);
        return c;
      }
    }
    return labFar(rd);
  }
  vec4 wave(vec2 xz){ return textureLod(uWave, xz/vec2(30.0,20.0), 0.0); }
  vec3 surfN(vec2 xz){ vec2 c = xz; vec4 i = wave(c);
    c += i.ba*0.15; i = wave(c); c += i.ba*0.15; i = wave(c);
    return vec3(i.b, sqrt(max(0.0,1.0-dot(i.ba,i.ba))), i.a); }
  float fresnel(float c){ return 0.02 + 0.98*pow(1.0-clamp(c,0.0,1.0), 5.0); }
  float edgeLine(vec3 p, vec3 lo, vec3 hi, float w){
    vec3 d = min(abs(p-lo), abs(p-hi)); int n = 0;
    if(d.x<w) n++; if(d.y<w) n++; if(d.z<w) n++; return n>=2 ? 1.0 : 0.0;
  }

  // 바닷물 밀도 (UNESCO 1981 해수 상태방정식, 수면 압력). T: °C, S: psu → kg/m³
  float seaRho(float T, float S){
    S = max(S, 0.0);
    float rw = 999.842594 + T*(6.793952e-2 + T*(-9.095290e-3 + T*(1.001685e-4 + T*(-1.120083e-6 + T*6.536332e-9))));
    float A = 0.824493 + T*(-4.0899e-3 + T*(7.6438e-5 + T*(-8.2467e-7 + T*5.3875e-9)));
    float B = -5.72466e-3 + T*(1.0227e-4 - T*1.6546e-6);
    return rw + A*S + B*S*sqrt(S) + 4.8314e-4*S*S;
  }
  float rhoAnom(vec4 s){ return seaRho(s.z, s.w) - seaRho(uT0, 0.0); }
  vec3 sliceColor(vec3 p){
    if(uView==3) return heat(sqrt(clamp(textureLod(uVel3, p/BOX, 0.0).w/uSpdMax, 0.0, 1.0)));
    float d = clamp(rhoAnom(textureLod(uVol, p/BOX, 0.0))/uDensMax, 0.0, 1.0);
    return heat(log(1.0+12.0*d)/log(13.0));
  }
  float cupLevel(){ return uMode==0 ? uCupTop-2.5 : uCupTop-3.5; }
  bool hasIce(){ return uMode==0 && uIce==1; }
  float iceSDF(vec3 p){
    float lvl = cupLevel(), d = 1e9;
    for(int i=0;i<4;i++){
      float fi = float(i), an = fi*1.65+0.5;
      vec2 cpos = uCup.xy + vec2(cos(an), sin(an))*uCup.z*(0.38+0.10*hash(vec2(fi,9.0)));
      vec3 hs = vec3(0.62, 0.50, 0.55) + 0.14*vec3(hash(vec2(fi,1.0)), hash(vec2(fi,6.0)), hash(vec2(fi,2.0)));
      vec3 q = p - vec3(cpos.x, lvl + 0.22 - 0.08*fi*0.5, cpos.y);
      float ra = an*1.9 + hash(vec2(fi,5.0)), tx = 0.10*(hash(vec2(fi,7.0))-0.5)*2.0;
      q.xz = mat2(cos(ra), -sin(ra), sin(ra), cos(ra))*q.xz;
      q.yz = mat2(cos(tx), -sin(tx), sin(tx), cos(tx))*q.yz;
      vec3 e = abs(q) - hs + 0.2;
      d = min(d, length(max(e, 0.0)) + min(max(e.x, max(e.y, e.z)), 0.0) - 0.2);
    }
    return d;
  }
  vec3 iceNormal(vec3 p){
    vec2 e = vec2(0.01, 0.0);
    return normalize(vec3(iceSDF(p+e.xyy)-iceSDF(p-e.xyy), iceSDF(p+e.yxy)-iceSDF(p-e.yxy), iceSDF(p+e.yyx)-iceSDF(p-e.yyx)));
  }
  // 컵: 위가 뚫린 원통. y = 0 없음, 1 겉면, 2 안쪽, 3 내용물, 4 바닥, 5 얼음
  vec2 cupHit(vec3 ro, vec3 rd, out vec3 nrm){
    vec2 oc = ro.xz-uCup.xy; vec2 d = rd.xz; float a = dot(d,d), b = dot(oc,d), c = dot(oc,oc)-uCup.z*uCup.z;
    float h = b*b-a*c; nrm = vec3(0.0,1.0,0.0);
    if(h<0.0 || a<1e-8) return vec2(1e9,0.0);
    h = sqrt(h); float t0 = (-b-h)/a, t1 = (-b+h)/a;
    float y0 = ro.y+rd.y*t0;
    if(t0>1e-3 && y0>uCup.w && y0<uCupTop){ vec3 p=ro+rd*t0; nrm=normalize(vec3(p.x-uCup.x,0.0,p.z-uCup.y)); return vec2(t0,1.0); }
    float lvl = cupLevel();
    if(rd.y<0.0 && y0>=uCupTop){
      float tc = (lvl-ro.y)/rd.y; vec3 p = ro+rd*tc;
      if(hasIce()){
        float ts = max((lvl+1.4-ro.y)/rd.y, (uCupTop-ro.y)/rd.y), te = min(tc, t1);
        float t = ts;
        for(int k=0;k<40;k++){
          if(t > te) break;
          vec3 pi = ro+rd*t; float dd = iceSDF(pi);
          if(dd < 0.004){ nrm = iceNormal(pi); return vec2(t, 5.0); }
          t += max(dd, 0.01);
        }
      }
      if(tc<t1 && distance(p.xz,uCup.xy)<uCup.z) return vec2(tc,3.0);
      float y1 = ro.y+rd.y*t1; if(y1>lvl && y1<uCupTop){ vec3 q=ro+rd*t1; nrm=-normalize(vec3(q.x-uCup.x,0.0,q.z-uCup.y)); return vec2(t1,2.0); }
    }
    if(rd.y>0.0 && y0<=uCup.w){ float tb=(uCup.w-ro.y)/rd.y; vec3 p=ro+rd*tb; if(tb>1e-3 && distance(p.xz,uCup.xy)<uCup.z){ nrm=vec3(0.0,-1.0,0.0); return vec2(tb,4.0);} }
    return vec2(1e9,0.0);
  }
  vec3 cupColor(vec2 ch, vec3 n, vec3 p, bool under){
    if(ch.y==3.0){
      vec2 q = p.xz-uCup.xy;
      vec3 liq = uMode==0 ? vec3(0.20,0.34,0.74) : vec3(0.66,0.12,0.12);
      liq *= 0.80 + 0.25*smoothstep(uCup.z, uCup.z*0.3, length(q));
      vec3 v = normalize(uCamPos-p);
      liq += 0.5*fresnel(v.y)*sky(reflect(-v, vec3(0.0,1.0,0.0)));
      if(hasIce()){
        float dd = iceSDF(vec3(p.x, cupLevel()+0.02, p.z));
        liq *= 1.0 - 0.35*smoothstep(0.45, 0.0, dd);
        liq += 0.10*smoothstep(0.06, 0.0, abs(dd-0.03));
      }
      return liq;
    }
    if(ch.y==5.0){
      vec3 v = normalize(uCamPos-p), rr = reflect(-v, n);
      float cv = clamp(dot(v, n), 0.0, 1.0);
      vec3 behind = vec3(0.20,0.34,0.74)*0.55 + vec3(0.30,0.38,0.46);
      float cloud = (0.35+0.65*vnoise(p.xz*3.1+p.y*2.3))*smoothstep(0.0, 0.6, -iceSDF(p - n*0.45));
      vec3 c = mix(behind, vec3(0.93,0.96,1.0), 0.22 + 0.55*cloud);
      float crack = smoothstep(0.03, 0.0, abs(vnoise(p.xz*2.4+p.y*1.7+3.0)-0.5));
      c = mix(c, vec3(1.0), crack*0.12);
      c *= 0.72 + 0.38*max(dot(n, uLight), 0.0);
      c += vec3(0.55,0.70,0.85)*0.35*pow(1.0-cv, 2.0);
      c += 0.6*fresnel(cv)*sky(rr) + vec3(1.0,0.99,0.96)*pow(max(dot(rr, uLight), 0.0), 90.0)*1.4;
      // 물에 잠긴 아래쪽은 물빛으로
      c = mix(c, vec3(0.30,0.45,0.80), smoothstep(cupLevel()+0.10, cupLevel()-0.05, p.y)*0.6);
      return c;
    }
    float ang = atan(p.z-uCup.y, p.x-uCup.x);
    float y = p.y;
    vec3 nn = n;
    float lip = 0.0;
    if(ch.y==1.0){
      // 맨 위 0.5 cm는 둥글게 말린 테두리
      float u = clamp((y-(uCupTop-0.5))/0.5, 0.0, 1.0);
      lip = step(uCupTop-0.5, y);
      nn = normalize(n + vec3(0.0, (u*2.0-1.0)*1.6*lip, 0.0));
    }
    float dif = 0.5 + 0.5*dot(nn, uLight);
    vec3 paper = vec3(0.965,0.955,0.93);
    paper *= 0.995 + 0.010*vnoise(vec2(ang*40.0, y*1.5)) - 0.012*vnoise(vec2(ang*6.0, y*0.5));
    vec3 c = paper*(0.42 + 0.62*dif);
    if(ch.y==1.0){
      float seam = abs(mod(ang+2.4, 6.28318)-3.14159);
      c *= 1.0 - 0.10*smoothstep(0.035, 0.0, seam) + 0.04*smoothstep(0.0,0.035,seam)*smoothstep(0.12,0.035,seam);
      c *= 1.0 - 0.10*smoothstep(0.08, 0.0, abs(y-(uCupTop-0.55)));
      c *= 0.80 + 0.20*smoothstep(uCup.w, uCup.w+1.5, y);
      vec3 rr = reflect(normalize(p-uCamPos), nn);
      c += vec3(1.0,0.99,0.96)*pow(max(dot(rr,uLight),0.0),24.0)*(0.10+0.25*lip);
      c += 0.06*fresnel(abs(dot(normalize(uCamPos-p), nn)))*sky(rr);
    }
    if(ch.y==2.0) c *= 0.55 + 0.30*smoothstep(uCupTop-4.0, uCupTop, y);
    if(ch.y==4.0) c *= 0.55;
    if(under) c *= 0.85 + 0.6*caustic(p);
    return c;
  }
  void sampleAt(vec3 p, float h, inout vec3 col, inout vec3 tr){
    vec4 s = textureLod(uVol, p/BOX, 0.0);
    vec3 sig = vec3(0.016,0.0045,0.003) + uInkK*s.x*vec3(0.95,0.62,0.16) + uInkK*s.y*vec3(0.10,0.85,0.75);
    if(uView != 0){
      // 물 전체를 색으로: 색(c)은 값 그대로, 진하기(k)는 수조 물과 다른 정도. 다를수록 진하게 쌓인다.
      float c, k;
      if(uView==3){ c = sqrt(clamp(textureLod(uVel3, p/BOX, 0.0).w/uSpdMax, 0.0, 1.0)); k = c; }
      else if(uView==1){ c = clamp(s.z/25.0, 0.0, 1.0); k = clamp(abs(s.z-uT0)/8.0, 0.0, 1.0); }
      else if(uView==4){ c = log(1.0+12.0*clamp(s.w/35.0, 0.0, 1.0))/log(13.0); k = c; }
      else { c = log(1.0+12.0*clamp(rhoAnom(s)/uDensMax, 0.0, 1.0))/log(13.0); k = c; }
      // 수온 보기는 수조 물(20 °C) 자체는 거의 투명하게: 차갑거나 따뜻한 물만 색이 쌓인다
      float a = 1.0-exp(-((uView==1 ? 0.006 : 0.03)+2.6*pow(k,1.2))*h);
      col += tr*a*heat(c); tr *= 1.0-a;
    }
    tr *= exp(-sig*h);
  }
  vec3 floorIn(vec3 p){
    vec3 rl = refRl();
    return vec3(0.80,0.84,0.85)*(0.36 + max(dot(-rl,vec3(0.0,1.0,0.0)),0.0)*caustic(p)*1.8);
  }
  void main(){
    vec2 ndc = gl_FragCoord.xy/uRes*2.0-1.0 - uShift;
    vec3 rd = normalize(uCamF + ndc.x*uTan*uAspect*uCamR + ndc.y*uTan*uCamU), ro = uCamPos;
    vec3 col = vec3(0.0), tr = vec3(1.0);
    float ew = 0.0016*length(vec3(15.0,10.0,10.0)-ro);
    // 마지막에 한 번만 칠한다: 0 배경, 1 컵, 2 수조 바닥
    int kind = 0; vec3 eo = ro, ed = rd, en = vec3(0.0,1.0,0.0); vec2 ec = vec2(0.0); bool under = false;
    vec3 cn; vec2 ch = cupHit(ro, rd, cn);
    vec2 gb = boxHit(ro, rd, GLO, GHI);
    vec2 wb = boxHit(ro, rd, vec3(0.0), BOX);
    bool water = wb.x < wb.y && wb.x > 0.0;
    bool trim = false;
    if(gb.x < gb.y && gb.x > 0.0 && gb.x < ch.x){
      vec3 pg = ro+rd*gb.x;
      bool topFace = pg.y > GHI.y-1e-3;
      float rim = min(min(pg.x-GLO.x, GHI.x-pg.x), min(pg.z-GLO.z, GHI.z-pg.z));
      if(pg.y < 0.35 || (pg.y > 21.3 && !topFace) || (topFace && rim < 0.7)){
        trim = true; eo = pg;
        vec3 c = pg-vec3(15.0,10.8,10.0); vec3 a = abs(c)/vec3(15.4,11.2,10.4);
        en = a.y>a.x && a.y>a.z ? vec3(0.0,sign(c.y),0.0) : a.x>a.z ? vec3(sign(c.x),0.0,0.0) : vec3(0.0,0.0,sign(c.z));
      } else {
        vec3 dd = min(abs(pg-GLO), abs(pg-GHI));
        float gw = max(0.55, ew*2.0);
        float vert = (dd.x < gw && dd.z < gw) ? 1.0 : 0.0;
        float e = (dd.x < gw ? 1.0 : 0.0) + (dd.y < gw ? 1.0 : 0.0) + (dd.z < gw ? 1.0 : 0.0) >= 2.0 ? 1.0 : 0.0;
        vec3 gn = dd.x < dd.y && dd.x < dd.z ? vec3(sign(pg.x-15.0),0.0,0.0) : dd.z < dd.y ? vec3(0.0,0.0,sign(pg.z-10.0)) : vec3(0.0,1.0,0.0);
        float Fg = fresnel(abs(dot(rd, gn)))*0.35;
        col += tr*Fg*sky(reflect(rd, gn)); tr *= 1.0-Fg;
        col += tr*e*vec3(0.30,0.52,0.48)*0.55; tr *= mix(vec3(0.97,0.985,0.98), vec3(0.42,0.62,0.58), e);
        tr *= 1.0 - vert*0.55;
      }
    }
    vec3 fnrm; float tf = foamHit(ro, rd, fnrm);
    if(trim){ kind = 3; }
    else if(tf < 1e8 && tf < ch.x && (!water || tf < wb.x + 0.5)){
      kind = 5; eo = ro+rd*tf; en = fnrm;
    }
    else if(ch.x < 1e8 && (!water || ch.x < wb.x)){
      kind = 1; ec = ch; en = cn; eo = ro+rd*ch.x;
    } else if(water){
      vec3 p = ro+rd*wb.x, n;
      bool top = p.y > 20.0-1e-3;
      if(top) n = surfN(p.xz);
      else { vec3 c = p-vec3(15.0,10.0,10.0); vec3 a = abs(c)/vec3(15.0,10.0,10.0);
        n = a.x>a.y && a.x>a.z ? vec3(sign(c.x),0.0,0.0) : a.z>a.y ? vec3(0.0,0.0,sign(c.z)) : vec3(0.0,sign(c.y),0.0); }
      float F = fresnel(dot(-rd,n)); if(!top) F = min(1.0, F*1.1+0.01);
      col += tr*F*sky(reflect(rd,n)); tr *= 1.0-F;
      vec3 d = refract(rd, n, 1.0/IOR), q0 = p, cnw;
      const float ds = 0.18;
      float t = ds*hash(gl_FragCoord.xy);
      vec2 cw = cupHit(q0, d, cnw); float tw = boxHit(q0, d, vec3(-1e-3), BOX+1e-3).y; float tEnd = min(tw, cw.x);
      bool sliced = true; int seg = 0;
      eo = q0; ed = d;
      for(int i=0;i<420;i++){
        if(t < tEnd){
          float h = min(ds, tEnd-t);
          sampleAt(q0+d*t, h, col, tr);
          if(!sliced){ float tz = (uSliceZ-q0.z)/d.z;
            if(tz>=t && tz<t+h){ sliced = true;
              vec3 c = sliceColor(q0+d*tz); col += tr*0.84*c; tr *= 0.16; } }
          t += ds;
          if(max(tr.r,max(tr.g,tr.b))<0.01){ tr = vec3(0.0); break; }
        } else {
        if(cw.x < tw){ kind = 1; ec = cw; en = cnw; eo = q0+d*cw.x; under = true; break; }
        vec3 q = q0+d*tw;
        if(q.y < 2e-3){ kind = 2; eo = q; break; }
        vec3 m; bool topHit = q.y > 20.0-2e-3;
        if(topHit) m = -surfN(q.xz);
        else { vec3 c = q-vec3(15.0,10.0,10.0); vec3 a = abs(c)/vec3(15.0,10.0,10.0); m = a.x>a.z ? vec3(-sign(c.x),0.0,0.0) : vec3(0.0,0.0,-sign(c.z)); }
        vec3 r = refract(d, m, IOR);
        if(topHit){ eo = q; ed = dot(r,r) > 0.5 ? r : vec3(0.0,1.0,0.0); break; }
        float Fe = dot(r,r) < 0.5 ? 1.0 : fresnel(abs(dot(r, m)));
        if(dot(r,r) < 0.5) r = d;
        float e = edgeLine(q, vec3(0.0), vec3(30.0,22.0,20.0), ew);
        float wl = abs(q.y-20.0) < ew*0.8 ? 1.0 : 0.0;
        col += tr*(e*vec3(0.40,0.56,0.55) + wl*vec3(0.62,0.78,0.82)*0.5); tr *= (1.0-e*0.85)*(1.0-wl*0.5)*vec3(0.965,0.985,0.98);
        col += tr*Fe*vec3(0.62,0.76,0.79)*0.85; tr *= 1.0-Fe;
        eo = q; ed = r; break;
        }
      }
    } else if(gb.x < gb.y && gb.y > 0.0){
      float e = edgeLine(ro+rd*gb.y,GLO,GHI,max(0.55, ew*2.0));
      col += tr*e*vec3(0.30,0.52,0.48)*0.5; tr *= mix(vec3(1.0), vec3(0.45,0.62,0.58), e);
    }
    vec3 last;
    if(kind==3){
      float dif = max(dot(en,uLight),0.0);
      vec3 rr = reflect(rd,en);
      float bev = 0.0;
      { vec3 d0 = min(abs(eo-GLO), abs(eo-GHI)); float m1 = min(d0.x, min(d0.y, d0.z));
        float m2 = d0.x+d0.y+d0.z - m1 - max(d0.x, max(d0.y, d0.z)); bev = smoothstep(0.18, 0.0, m2); }
      last = vec3(0.075,0.08,0.085)*(0.55+0.6*dif) + 0.18*fresnel(dot(-rd,en))*sky(rr)
           + vec3(1.0,0.98,0.95)*pow(max(dot(rr,uLight),0.0),60.0)*0.35 + vec3(0.35)*bev;
    }
    else if(kind==1) last = cupColor(ec, en, eo, under)*(under ? vec3(0.85,0.95,0.97) : vec3(1.0));
    else if(kind==2) last = floorIn(eo);
    else if(kind==5){
      // 스티로폼: 흰 알갱이가 뭉친 무른 표면
      float g = 0.92 + 0.08*hash(floor(eo.xz*14.0)+floor(eo.y*14.0));
      last = vec3(0.97,0.97,0.95)*g*(0.55 + 0.5*max(dot(en,uLight),0.0));
    }
    else last = background(eo, ed, water && !trim && !(ch.x < 1e8 && ch.x < wb.x));
    col += tr*last;
    // 색 단면: 화살표와 같은 자리에 굴절 없이 겹쳐 그린다.
    if(uSlice==1 && kind!=3 && abs(rd.z) > 1e-4){
      float tz = (uSliceZ-ro.z)/rd.z; vec3 ps = ro+rd*tz;
      bool inCupS = ps.y > uCup.w && distance(ps.xz, uCup.xy) < uCup.z;
      if(tz > 0.0 && tz < ch.x && ps.x > 0.0 && ps.x < 30.0 && ps.y > 0.0 && ps.y < 20.0 && !inCupS)
        col = mix(col, sliceColor(ps)*0.97, 0.84);
    }
    vec2 uv = gl_FragCoord.xy/uRes - 0.5;
    col *= 1.0 - 0.32*dot(uv,uv);
    col += (hash(gl_FragCoord.xy+0.37)-0.5)/255.0;
    o = vec4(col, 1.0);
  }`;

  window.WaterShaders = { WAVE_DROP, WAVE_UPDATE, WAVE_NORMAL, CAUSTIC_VS, CAUSTIC_FS, RENDER };
})();
