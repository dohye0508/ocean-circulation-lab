// 수조 주위를 도는 카메라
(function () {
  'use strict';
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const VIEWS = { oblique: { yaw: -0.22, pitch: 0.30, dist: 62 }, front: { yaw: 0, pitch: 0.04, dist: 58 } };

  class OrbitCamera {
    constructor() { this.target = [15, 10, 10]; this.fov = 34 * Math.PI / 180; this.set('oblique'); }
    set(name) { Object.assign(this, VIEWS[name]); this.name = name; }
    rotate(dx, dy) { this.yaw -= dx * 0.006; this.pitch = Math.max(-0.2, Math.min(1.35, this.pitch + dy * 0.005)); this.name = null; }
    zoom(f) { this.dist = Math.max(30, Math.min(140, this.dist * f)); }
    // shift: 패널에 가린 만큼 화면 중심을 옮긴다 (NDC 단위)
    compute(width, height, shift) {
      const cp = Math.cos(this.pitch);
      const pos = [this.target[0] + this.dist * Math.sin(this.yaw) * cp, this.target[1] + this.dist * Math.sin(this.pitch), this.target[2] + this.dist * Math.cos(this.yaw) * cp];
      const fwd = norm(sub(this.target, pos)), right = norm(cross(fwd, [0, 1, 0])), up = cross(right, fwd);
      const aspect = width / height, tan = Math.tan(this.fov / 2);
      const f = 1 / tan, n = 1, fa = 500;
      const view = [right[0], up[0], -fwd[0], 0, right[1], up[1], -fwd[1], 0, right[2], up[2], -fwd[2], 0, -dot(right, pos), -dot(up, pos), dot(fwd, pos), 1];
      const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
      const vp = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += proj[k * 4 + r] * view[c * 4 + k]; vp[c * 4 + r] = s; }
      return { pos, fwd, right, up, aspect, tan, viewProj: vp, shift };
    }
  }
  window.OrbitCamera = OrbitCamera;
})();
