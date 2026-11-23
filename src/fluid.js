// 3D 부시네스크 유체 계산기 (WebGL2)
// 격자: 60 x 40 x 40칸, 한 칸 0.5 cm. 수조 30 x 20 x 20 cm의 물을 계산한다.
(function () {
  'use strict';
  const NX = 60, NY = 40, NZ = 40, DX = 0.5, TX = 8, TY = 5;
  const W = NX * TX, H = NY * TY;
  const G = 981, ALPHA = 2.0e-4, BETA = 7.6e-4;
  // 바닷물 밀도 (UNESCO 1981 해수 상태방정식, 수면 압력). T: °C, S: psu → kg/m³
  function seaRho(T, S) {
    S = Math.max(S, 0);
    const rw = 999.842594 + T * (6.793952e-2 + T * (-9.095290e-3 + T * (1.001685e-4 + T * (-1.120083e-6 + T * 6.536332e-9))));
    const A = 0.824493 + T * (-4.0899e-3 + T * (7.6438e-5 + T * (-8.2467e-7 + T * 5.3875e-9)));
    const B = -5.72466e-3 + T * (1.0227e-4 - T * 1.6546e-6);
    return rw + A * S + B * S * Math.sqrt(S) + 4.8314e-4 * S * S;
  }
  const DT = 0.05, JACOBI = 40;
  const WW = 192, WH = 128, CW = 768, CH = 512, GC = 150, GR = 100, CMAP = [-15, -10, 60, 40];
  const WS = window.WaterShaders;

  const VS = `#version 300 es
  void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

  const COMMON = `#version 300 es
  precision highp float; precision highp int; precision highp sampler2D; precision highp sampler3D;
  uniform ivec3 uN; uniform int uTX; uniform float uDx; uniform vec4 uCup;
  ivec2 apx(ivec3 c){ int tx=c.z%uTX; int ty=c.z/uTX; return ivec2(tx*uN.x+c.x, ty*uN.y+c.y); }
  ivec3 cellOf(ivec2 p){ int tx=p.x/uN.x; int ty=p.y/uN.y; return ivec3(p.x-tx*uN.x, p.y-ty*uN.y, ty*uTX+tx); }
  bool outside(ivec3 c){ return any(lessThan(c,ivec3(0))) || any(greaterThanEqual(c,uN)); }
  bool inCup(vec3 p){ return p.y > uCup.w && distance(p.xz,uCup.xy) < uCup.z; }
  bool solid(ivec3 c){ return outside(c) || inCup((vec3(c)+0.5)*uDx); }
  vec4 F(sampler2D t, ivec3 c){ return texelFetch(t, apx(clamp(c,ivec3(0),uN-1)), 0); }
  vec4 S(sampler2D t, vec3 x, out vec4 mn, out vec4 mx){
    x = clamp(x-0.5, vec3(0), vec3(uN-1));
    ivec3 i = min(ivec3(floor(x)), uN-2); vec3 f = x-vec3(i);
    vec4 a=F(t,i), b=F(t,i+ivec3(1,0,0)), c=F(t,i+ivec3(0,1,0)), d=F(t,i+ivec3(1,1,0));
    vec4 e=F(t,i+ivec3(0,0,1)), g=F(t,i+ivec3(1,0,1)), h=F(t,i+ivec3(0,1,1)), k=F(t,i+ivec3(1,1,1));
    mn=min(min(min(a,b),min(c,d)),min(min(e,g),min(h,k)));
    mx=max(max(max(a,b),max(c,d)),max(max(e,g),max(h,k)));
    return mix(mix(mix(a,b,f.x),mix(c,d,f.x),f.y), mix(mix(e,g,f.x),mix(h,k,f.x),f.y), f.z);
  }
  vec4 S(sampler2D t, vec3 x){ vec4 a,b; return S(t,x,a,b); }
  out vec4 o;

  // 바닷물 밀도 (UNESCO 1981 해수 상태방정식, 수면 압력). T: °C, S: psu → kg/m³
  float seaRho(float T, float S){
    S = max(S, 0.0);
    float rw = 999.842594 + T*(6.793952e-2 + T*(-9.095290e-3 + T*(1.001685e-4 + T*(-1.120083e-6 + T*6.536332e-9))));
    float A = 0.824493 + T*(-4.0899e-3 + T*(7.6438e-5 + T*(-8.2467e-7 + T*5.3875e-9)));
    float B = -5.72466e-3 + T*(1.0227e-4 - T*1.6546e-6);
    return rw + A*S + B*S*sqrt(S) + 4.8314e-4*S*S;
  }
  `;

  // 이류: 속도장을 따라 거슬러 올라간 위치의 값을 가져온다 (RK2).
  const ADVECT = COMMON + `
  uniform sampler2D uVel, uSrc; uniform float uDt, uSign; uniform int uZeroSolid;
  void main(){
    ivec3 c = cellOf(ivec2(gl_FragCoord.xy)); if(c.z>=uN.z){o=vec4(0);return;}
    if(uZeroSolid==1 && solid(c)){o=vec4(0);return;}
    vec3 x = vec3(c)+0.5; vec3 v = F(uVel,c).xyz;
    vec3 vm = S(uVel, x-0.5*uSign*uDt*v/uDx).xyz;
    o = S(uSrc, x-uSign*uDt*vm/uDx);
  }`;

  // MacCormack 보정 + 열원, 염분원, 잉크
  const SCALAR = COMMON + `
  uniform sampler2D uVel, uPhi, uHat, uBar; uniform float uDt;
  uniform int uMode, uIce; uniform float uT0, uTice, uSsalt, uTcup; uniform vec4 uDrop;
  void main(){
    ivec3 c = cellOf(ivec2(gl_FragCoord.xy)); if(c.z>=uN.z){o=vec4(0);return;}
    vec3 p = (vec3(c)+0.5)*uDx;
    if(inCup(p)){ o = vec4(uT0, 0.0, 0.0, 0.0); return; }
    vec3 x = vec3(c)+0.5; vec3 v = F(uVel,c).xyz;
    vec3 vm = S(uVel, x-0.5*uDt*v/uDx).xyz;
    vec4 mn, mx; S(uPhi, x-uDt*vm/uDx, mn, mx);
    vec4 r = clamp(F(uHat,c) + 0.5*(F(uPhi,c)-F(uBar,c)), mn, mx);
    float dr = distance(p.xz, uCup.xy) - uCup.z;
    // 컵 바닥 구멍 아래: 수온 실험은 파란 잉크를 탄 컵 속 물, 염분 실험은 빨간 잉크를 탄 소금물이 흘러나온다.
    if(distance(p.xz,uCup.xy) < 0.9 && p.y > uCup.w-1.0 && p.y <= uCup.w){
      float k = 1.0-exp(-uDt/0.3);
      if(uMode==0){ r.x += (uTcup-r.x)*k; r.y += (0.0-r.y)*k; r.z += (1.0-r.z)*k; }
      else { r.x += (uT0-r.x)*k; r.y += (uSsalt-r.y)*k; r.w += (1.0-r.w)*k; }
    }
    if(uDrop.w > 0.0){ float d = distance(p, uDrop.xyz); r.w = max(r.w, smoothstep(uDrop.w, uDrop.w*0.4, d)); }
    o = r;
  }`;

  // 부력, 점성, 소금물 분출
  const FORCE = COMMON + `
  uniform sampler2D uVel, uScal; uniform float uDt, uT0, uS0, uG, uAlpha, uBeta, uNu; uniform int uMode;
  void main(){
    ivec3 c = cellOf(ivec2(gl_FragCoord.xy)); if(c.z>=uN.z || solid(c)){o=vec4(0);return;}
    vec3 v = F(uVel,c).xyz; vec4 s = F(uScal,c);
    float r0 = seaRho(uT0, uS0);
    v.y -= uDt*uG*(seaRho(s.x, s.y) - r0)/r0;
    vec3 lap = -6.0*v;
    for(int a=0;a<3;a++){ ivec3 e=ivec3(0); e[a]=1;
      lap += solid(c+e)?vec3(0):F(uVel,c+e).xyz; lap += solid(c-e)?vec3(0):F(uVel,c-e).xyz; }
    v += uDt*uNu*lap/(uDx*uDx);
    { vec3 p=(vec3(c)+0.5)*uDx;
      if(distance(p.xz,uCup.xy)<0.9 && p.y>uCup.w-1.0) v.y = mix(v.y, -1.0, 1.0-exp(-uDt/0.3)); }
    o = vec4(v,0);
  }`;

  const DIVERGENCE = COMMON + `
  uniform sampler2D uVel;
  void main(){
    ivec3 c = cellOf(ivec2(gl_FragCoord.xy)); if(c.z>=uN.z || solid(c)){o=vec4(0);return;}
    float d = 0.0;
    for(int a=0;a<3;a++){ ivec3 e=ivec3(0); e[a]=1;
      float hi = solid(c+e)?0.0:F(uVel,c+e)[a]; float lo = solid(c-e)?0.0:F(uVel,c-e)[a]; d += hi-lo; }
    o = vec4(0.5*d/uDx,0,0,0);
  }`;

  const JACOBI_FS = COMMON + `
  uniform sampler2D uP, uDiv;
  void main(){
    ivec3 c = cellOf(ivec2(gl_FragCoord.xy)); if(c.z>=uN.z || solid(c)){o=vec4(0);return;}
    float pc = F(uP,c).x, s = 0.0;
    for(int a=0;a<3;a++){ ivec3 e=ivec3(0); e[a]=1;
      s += solid(c+e)?pc:F(uP,c+e).x; s += solid(c-e)?pc:F(uP,c-e).x; }
    o = vec4((s - uDx*uDx*F(uDiv,c).x)/6.0,0,0,0);
  }`;

  const GRADIENT = COMMON + `
  uniform sampler2D uP, uVel;
  void main(){
    ivec3 c = cellOf(ivec2(gl_FragCoord.xy)); if(c.z>=uN.z || solid(c)){o=vec4(0);return;}
    float pc = F(uP,c).x; vec3 v = F(uVel,c).xyz;
    for(int a=0;a<3;a++){ ivec3 e=ivec3(0); e[a]=1;
      bool sh = solid(c+e), sl = solid(c-e);
      float ph = sh?pc:F(uP,c+e).x, pl = sl?pc:F(uP,c-e).x;
      v[a] -= 0.5*(ph-pl)/uDx;
      if((sh && v[a]>0.0) || (sl && v[a]<0.0)) v[a]=0.0;
    }
    o = vec4(v,0);
  }`;

  // 3D 텍스처 한 층으로 복사 (그리기용)
  const COPY = COMMON + `
  uniform sampler2D uScal; uniform int uLayer;
  void main(){ o = F(uScal, ivec3(ivec2(gl_FragCoord.xy), uLayer)).zwxy; }`;
  const COPY_VEL = COMMON + `
  uniform sampler2D uScal; uniform int uLayer;
  void main(){ vec3 v = F(uScal, ivec3(ivec2(gl_FragCoord.xy), uLayer)).xyz; o = vec4(v, length(v)); }`;

  // 단면 흐름 화살표 (월드 좌표의 납작한 화살표)
  const ARROW_VS = `#version 300 es
  precision highp float; precision highp int; precision highp sampler2D;
  uniform sampler2D uVel; uniform ivec3 uN; uniform int uTX, uStep, uCols, uK; uniform float uDx, uVmax, uLen;
  uniform mat4 uVP; uniform vec2 uShift; uniform vec4 uCup;
  out float vA; out vec3 vP;
  ivec2 apx(ivec3 c){ int tx=c.z%uTX; int ty=c.z/uTX; return ivec2(tx*uN.x+c.x, ty*uN.y+c.y); }
  void main(){
    int ix = gl_InstanceID % uCols, iy = gl_InstanceID / uCols;
    ivec3 c = ivec3(ix*uStep + uStep/2, iy*uStep + uStep/2, uK);
    vec3 v = texelFetch(uVel, apx(c), 0).xyz; vec2 v2 = v.xy; float sp = length(v2);
    vec3 base = (vec3(c)+0.5)*uDx;
    bool cup = base.y > uCup.w-0.3 && distance(base.xz,uCup.xy) < uCup.z+0.3;
    float L = uLen*sqrt(min(sp/max(uVmax,1e-4),1.0));
    vA = (sp < 0.02*uVmax || cup || c.y>=uN.y) ? 0.0 : clamp(0.35+sp/uVmax,0.0,1.0);
    vec2 d = sp>0.0 ? v2/sp : vec2(1,0); vec2 n = vec2(-d.y,d.x);
    vec2 tail = -d*L*0.5, tip = d*L*0.5, hb = tip - d*L*0.38;
    float sw = 0.07, hw = max(L*0.22, 0.12);
    vec2 q[9] = vec2[9](tail+n*sw, tail-n*sw, hb+n*sw, hb+n*sw, tail-n*sw, hb-n*sw, hb+n*hw, hb-n*hw, tip);
    vec3 p = base + vec3(q[gl_VertexID],0.0); p.z = base.z + 0.02;
    vP = p; vec4 cp = uVP*vec4(p,1.0); cp.xy += uShift*cp.w; gl_Position = cp;
  }`;
  const ARROW_FS = `#version 300 es
  precision highp float; in float vA; in vec3 vP; uniform vec3 uColor, uCamPos; uniform vec4 uCup; uniform float uCupTop; out vec4 o;
  bool hidden(){
    vec3 ro = uCamPos, rd = vP-ro; float L = length(rd); rd /= L;
    vec2 oc = ro.xz-uCup.xy, d = rd.xz; float a = dot(d,d), b = dot(oc,d), c = dot(oc,oc)-uCup.z*uCup.z, h = b*b-a*c;
    if(h < 0.0 || a < 1e-8) return false;
    h = sqrt(h); float t0 = (-b-h)/a, t1 = (-b+h)/a;
    float y0 = ro.y+rd.y*t0, y1 = ro.y+rd.y*t1;
    if(t0 > 0.0 && t0 < L-0.05 && y0 > uCup.w && y0 < uCupTop) return true;
    if(t1 > 0.0 && t1 < L-0.05 && y1 > uCup.w && y1 < uCupTop) return true;
    return false;
  }
  void main(){ if(vA<=0.0 || hidden()) discard; o = vec4(uColor, 0.9*vA); }`;

  class OceanSim {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL2를 쓸 수 없는 브라우저입니다.');
      this.gl = gl; this.canvas = canvas;
      const half = !gl.getExtension('EXT_color_buffer_float');
      if (half && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('부동소수 렌더 타깃을 지원하지 않습니다.');
      gl.getExtension('OES_texture_float_linear');
      this.fmt = half ? gl.RGBA16F : gl.RGBA32F;
      this.ftype = half ? gl.HALF_FLOAT : gl.FLOAT;
      this.vao = gl.createVertexArray();
      const mk = fs => this.program(VS, fs);
      this.p = { advect: mk(ADVECT), scalar: mk(SCALAR), force: mk(FORCE), div: mk(DIVERGENCE),
        jacobi: mk(JACOBI_FS), grad: mk(GRADIENT), copy: mk(COPY), copyVel: mk(COPY_VEL), render: mk(WS.RENDER),
        arrow: this.program(ARROW_VS, ARROW_FS), wdrop: mk(WS.WAVE_DROP), wupdate: mk(WS.WAVE_UPDATE),
        wnormal: mk(WS.WAVE_NORMAL), caustic: this.program(WS.CAUSTIC_VS, WS.CAUSTIC_FS) };
      // 수면 물결 (192 x 128)과 바닥 커스틱 텍스처
      this.wave = [this.target(WW, WH, gl.RGBA16F, gl.LINEAR), this.target(WW, WH, gl.RGBA16F, gl.LINEAR)];
      this.caus = this.target(CW, CH, gl.RGBA8, gl.LINEAR);
      const idx = new Uint16Array((GC - 1) * (GR - 1) * 6); let n = 0;
      for (let j = 0; j < GR - 1; j++) for (let i = 0; i < GC - 1; i++) { const a = j * GC + i; idx.set([a, a + 1, a + GC, a + 1, a + GC + 1, a + GC], n); n += 6; }
      this.gridVao = gl.createVertexArray(); gl.bindVertexArray(this.gridVao);
      const eb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      this.gridCount = idx.length; gl.bindVertexArray(null);
      this.light = (() => { const v = [-0.45, 1.0, 0.55], l = Math.hypot(...v); return v.map(x => x / l); })();
      const T = () => this.target();
      this.vel = [T(), T()]; this.scal = [T(), T()]; this.hat = T(); this.bar = T(); this.pr = [T(), T()]; this.dv = T();
      this.vol = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.vol);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, NX, NY, NZ);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, k, gl.LINEAR);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
      this.velVol = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.velVol);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, NX, NY, NZ);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, k, gl.LINEAR);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, k, gl.CLAMP_TO_EDGE);
      this.volFb = gl.createFramebuffer();
      this.readBuf = new Float32Array(W * H * 4); this.readVel = new Float32Array(W * H * 4);
      this.params = { mode: 0, ice: 1, T0: 20, Tice: 1, Tcup: 1, Ssalt: 50, pos: 4 };
      this.drop = null; this.time = 0;
      this.reset();
    }
    program(vs, fs) {
      const gl = this.gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n')); return s; };
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      const u = {}; const n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(pr, i); u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(pr, info.name), type: info.type }; }
      return { pr, u };
    }
    target(w = W, h = H, fmt = this.fmt, filter) {
      const gl = this.gl, tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
      const f = filter || gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h };
    }
    wavePass(prog, uniforms) {
      const gl = this.gl; this.use(prog, Object.assign({ uTex: this.wave[0], uSize: [WW, WH] }, uniforms));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.wave[1].fb); gl.viewport(0, 0, WW, WH);
      gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.wave = [this.wave[1], this.wave[0]];
    }
    // 수면에 물방울이 떨어진 것처럼 물결을 만든다 (x, z: cm)
    ripple(x, z, radius = 0.9, strength = 0.05) { this.wavePass(this.p.wdrop, { uCenter: [x, z], uRadius: radius, uStrength: strength }); }
    stepWaves() {
      if (Math.random() < 0.25) this.ripple(Math.random() * 30, Math.random() * 20, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.02);
      for (let i = 0; i < 2; i++) this.wavePass(this.p.wupdate, {});
      this.wavePass(this.p.wnormal, { uCell: 30 / WW });
      const gl = this.gl;
      this.use(this.p.caustic, { uWave: this.wave[0], uCols: GC, uRows: GR, uLight: this.light, uMap: CMAP });
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.caus.fb); gl.viewport(0, 0, CW, CH);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.gridVao); gl.drawElements(gl.TRIANGLES, this.gridCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND); gl.bindVertexArray(null);
    }
    use(prog, uniforms) {
      const gl = this.gl; gl.useProgram(prog.pr); let unit = 0;
      const all = Object.assign({ uN: [NX, NY, NZ], uTX: TX, uDx: DX, uCup: this.cupVec() }, uniforms);
      for (const name in all) {
        const info = prog.u[name]; if (!info) continue; const v = all[name], l = info.loc;
        switch (info.type) {
          case gl.SAMPLER_2D: case gl.SAMPLER_3D:
            gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(info.type === gl.SAMPLER_3D ? gl.TEXTURE_3D : gl.TEXTURE_2D, v.tex || v); gl.uniform1i(l, unit++); break;
          case gl.INT: gl.uniform1i(l, v); break;
          case gl.INT_VEC3: gl.uniform3iv(l, v); break;
          case gl.FLOAT: gl.uniform1f(l, v); break;
          case gl.FLOAT_VEC2: gl.uniform2fv(l, v); break;
          case gl.FLOAT_VEC3: gl.uniform3fv(l, v); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(l, v); break;
          case gl.FLOAT_MAT4: gl.uniformMatrix4fv(l, false, v); break;
        }
      }
    }
    pass(prog, out, uniforms) {
      const gl = this.gl; this.use(prog, uniforms);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb); gl.viewport(0, 0, W, H);
      gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    cupVec() {
      const p = this.params; // x, z, 반지름, 컵 바닥 높이 (cm)
      return [p.pos, 10, 3.0, 18.5];
    }
    reset() {
      const gl = this.gl, p = this.params;
      const clear = (t, v) => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(...v); gl.clear(gl.COLOR_BUFFER_BIT); };
      for (const t of [...this.vel, ...this.pr, this.dv, this.hat, this.bar]) clear(t, [0, 0, 0, 0]);
      for (const t of this.scal) clear(t, [p.T0, 0, 0, 0]);
      if (this.wave) for (const t of this.wave) clear(t, [0, 0, 0, 0]);
      this.time = 0; this.drop = null;
    }
    dropInk(x, y, z, r) { this.drop = [x, y, z, r || 1.2]; }
    step() {
      const p = this.params, dt = DT;
      const [v0, v1] = this.vel, [s0, s1] = this.scal;
      // 온도, 염분, 잉크 이류
      this.pass(this.p.advect, this.hat, { uVel: v0, uSrc: s0, uDt: dt, uSign: 1, uZeroSolid: 0 });
      this.pass(this.p.advect, this.bar, { uVel: v0, uSrc: this.hat, uDt: dt, uSign: -1, uZeroSolid: 0 });
      this.pass(this.p.scalar, s1, { uVel: v0, uPhi: s0, uHat: this.hat, uBar: this.bar, uDt: dt,
        uMode: p.mode, uIce: p.ice, uT0: p.T0, uTice: p.Tice, uSsalt: p.Ssalt, uTcup: p.Tcup, uDrop: this.drop || [0, 0, 0, 0] });
      this.drop = null;
      this.scal = [s1, s0];
      // 속도 이류, 부력, 압력 투영
      this.pass(this.p.advect, v1, { uVel: v0, uSrc: v0, uDt: dt, uSign: 1, uZeroSolid: 1 });
      this.pass(this.p.force, v0, { uVel: v1, uScal: s1, uDt: dt, uT0: p.T0, uS0: 0, uG: G, uAlpha: ALPHA, uBeta: BETA, uNu: 0.25, uMode: p.mode });
      this.pass(this.p.div, this.dv, { uVel: v0 });
      for (let i = 0; i < JACOBI; i++) {
        this.pass(this.p.jacobi, this.pr[1], { uP: this.pr[0], uDiv: this.dv });
        this.pr = [this.pr[1], this.pr[0]];
      }
      this.pass(this.p.grad, v1, { uP: this.pr[0], uVel: v0 });
      this.vel = [v1, v0];
      this.time += dt;
    }
    updateVolume(prog = this.p.copy, src = this.scal[0], dst = this.vol) {
      const gl = this.gl; this.use(prog, { uScal: src });
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.volFb); gl.viewport(0, 0, NX, NY); gl.bindVertexArray(this.vao);
      const loc = prog.u.uLayer.loc;
      for (let k = 0; k < NZ; k++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, dst, 0, k);
        gl.uniform1i(loc, k); gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    render(cam, view) {
      const gl = this.gl, c = this.canvas, p = this.params;
      this.updateVolume();
      if (view.mode === 3) this.updateVolume(this.p.copyVel, this.vel[0], this.velVol);
      if (view.waves !== false) this.stepWaves();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, c.width, c.height);
      const cup = this.cupVec();
      this.use(this.p.render, { uWave: this.wave[0], uCaustic: this.caus, uLight: this.light, uMap: CMAP, uInkK: view.inkK || 0.9, uFoam: view.foam || new Float32Array(32), uVol: this.vol, uVel3: this.velVol, uSpdMax: view.spdMax || 6, uRes: [c.width, c.height], uShift: cam.shift, uCamPos: cam.pos, uCamR: cam.right, uCamU: cam.up, uCamF: cam.fwd,
        uTan: cam.tan, uAspect: cam.aspect, uCup: cup, uCupTop: cup[3] + 9, uMode: p.mode, uView: view.mode, uIce: p.ice, uSlice: view.slice ? 1 : 0,
        uT0: p.T0, uSliceZ: 10.25, uDensMax: view.densMax, uSsalt: p.Ssalt });
      if (!view.noScene) { gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      if (view.arrows) {
        const step = 3, cols = Math.floor(NX / step), rows = Math.ceil(NY / step);
        this.use(this.p.arrow, { uVel: this.vel[0], uStep: step, uCols: cols, uK: 20, uVmax: view.vmax, uLen: 1.9, uVP: cam.viewProj, uShift: cam.shift, uCamPos: cam.pos, uCup: cup, uCupTop: cup[3] + 9,
          uColor: view.mode === 0 ? [0.08, 0.16, 0.24] : [0.04, 0.05, 0.07] });
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 9, cols * rows);
        gl.disable(gl.BLEND);
      }
    }
    // 격자 전체를 읽어 관찰값을 계산한다.
    // 수면 바로 아래(맨 위 칸)의 수평 속도 (cm/s). stats()가 읽어 둔 속도장을 쓴다.
    surfaceVel(x, z) {
      const v = this.readVel, i = Math.max(0, Math.min(NX - 1, Math.floor(x / DX))), k = Math.max(0, Math.min(NZ - 1, Math.floor(z / DX))), j = NY - 1;
      const q = ((Math.floor(k / TX) * NY + j) * W + (k % TX) * NX + i) * 4;
      return [v[q], v[q + 2]];
    }
    stats() {
      const gl = this.gl, s = this.readBuf, v = this.readVel, p = this.params;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scal[0].fb); gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, s);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.vel[0].fb); gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, v);
      const cup = this.cupVec(), away = cup[0] < 15 ? 1 : -1;
      let lowest = NY, sink = 0, vmax = 0, far = 0, surf = 0;
      const layer = () => ({ T: 0, S: 0, u: 0, n: 0 });
      const top = layer(), bot = layer();
      for (let k = 0; k < NZ; k++) {
        const ox = (k % TX) * NX, oy = Math.floor(k / TX) * NY, z = (k + 0.5) * DX;
        for (let j = 0; j < NY; j++) {
          const y = (j + 0.5) * DX;
          for (let i = 0; i < NX; i++) {
            const x = (i + 0.5) * DX;
            if (y > cup[3] && Math.hypot(x - cup[0], z - cup[1]) < cup[2]) continue;
            const q = ((oy + j) * W + ox + i) * 4;
            const ink = s[q + 2] + s[q + 3], vy = v[q + 1];
            const along = (x - cup[0]) * away;
            if (ink > 0.08 && j < 4 && along > far) far = along;
            if (ink > 0.08 && j >= NY - 4 && along > surf) surf = along;
            const sp = Math.hypot(v[q], vy, v[q + 2]); if (sp > vmax) vmax = sp;
            if (ink > 0.06 && j < lowest) lowest = j;
            if (ink > 0.1 && -vy > sink) sink = -vy;
            const L = j >= NY - 3 ? top : j < 3 ? bot : null;
            if (L) { L.T += s[q]; L.S += s[q + 1]; L.u += v[q] * away; L.n++; }
          }
        }
      }
      for (const L of [top, bot]) { L.T /= L.n; L.S /= L.n; L.u /= L.n; }
      const rho = L => seaRho(L.T, L.S);
      return { time: this.time, depth: lowest < NY ? 20 - lowest * DX : null, sink, vmax, far, surf, wallDist: (away > 0 ? 30 - cup[0] : cup[0]) - 3,
        topT: top.T, botT: bot.T, topS: top.S, botS: bot.S, drho: rho(bot) - rho(top), topU: top.u, botU: bot.u };
    }
  }
  OceanSim.grid = { NX, NY, NZ, DX, DT, ALPHA, BETA, G };
  OceanSim.seaRho = seaRho;
  window.OceanSim = OceanSim;
})();
