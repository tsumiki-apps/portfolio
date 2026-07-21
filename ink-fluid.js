/* ============================================================
   墨の流体シミュレーション（GPU / WebGL）
   紙×墨ポートフォリオのヒーロー背景。指/マウスの動きと画面遷移で、
   透明な紙の上に墨が立ち上り、渦を巻いて拡散する。

   物理コアは Pavel Dobryakov の WebGL-Fluid-Simulation（MIT）の
   手法を土台に、単色・墨・透明合成へ最小化して再構成。
   さらに kazera.jp の演出構造（letterform splat / paper-cutout wall /
   virtual sweep / wash transition / MODES / dynamic dtScale）を移植。
   ============================================================ */
(function () {
  'use strict';
  const canvas = document.getElementById('inkFluid');
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // ---- 共通パラメータ（モードに依らない固定値） ----
  const config = {
    SIM_RESOLUTION: 128,       // 速度場の解像度
    DYE_RESOLUTION: 640,       // 墨（染料）の解像度
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 4,                   // 渦の強さ（低く＝モヤモヤせず滑らかな塊に）
  };
  const INK = [0.02, 0.02, 0.02];  // 墨色（ほぼ漆黒）
  const DYE_CAP = 1.2;             // letterform 注入の自己制限（過飽和を防ぎ、washで消えやすく）

  // ---- 画面ごとのモード（散逸・注入量・半径・力・時間倍率） ----
  //   velDiss:  流れの減衰（大きいほど早く止まる）
  //   dyeDiss:  墨の消え方（大きいほど早く消える）
  //   letterK:  letterform（文字形）から毎フレーム注入する墨の量
  //   cursorR:  指/マウスの一滴の広がり
  //   cursorF:  指の押し出す力
  //   cursorI:  一滴で足す墨の濃さ
  //   dtScale:  シミュレーション時間の倍率
  //   wall:     紙の切り抜き（墨が文字を避けて流れる）を使うか
  //   wash:     この画面に入るとき残留墨を拭き取るか
  const MODES = {
    intro: { velDiss: 0.25, dyeDiss: 0.90, letterK: 0.0,   cursorR: 0.30, cursorF: 5200, cursorI: 0.34, dtScale: 1.0, wall: false, wash: true,  hoverInk: true  },
    brand: { velDiss: 0.14, dyeDiss: 0.25, letterK: 0.022, cursorR: 0.30, cursorF: 5200, cursorI: 0.34, dtScale: 1.0, wall: false, wash: false, hoverInk: true  },  // letterK 以前の値: 0.060（大きいほど早く暗転）
    menu:  { velDiss: 0.14, dyeDiss: 0.25, letterK: 0.060, cursorR: 0.34, cursorF: 5500, cursorI: 0.55, dtScale: 1.0, wall: false, wash: false, hoverInk: true  },
    // sheet は読み物。マウスは「押している間だけ」描く＝スマホ（touchmove）と同じ挙動に揃える
    sheet: { velDiss: 0.30, dyeDiss: 1.00, letterK: 0.0,   cursorR: 0.30, cursorF: 5200, cursorI: 0.34, dtScale: 1.0, wall: false, wash: true,  hoverInk: false },
  };
  let mode = MODES.intro;
  let currentScreen = 'intro';

  // wash transition：washUntil までの間、散逸を強めて残留墨を拭き取る
  let washUntil = 0;
  const WASH_MS = 800, WASH_DYE_MUL = 5.0, WASH_VEL_MUL = 3.0;
  const WASH_DYE_MIN = 4.0, WASH_VEL_MIN = 1.2;   // 散逸が低いモードでも確実に拭き取る下限

  const { gl, ext } = getWebGLContext(canvas);
  if (!gl) return;
  if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
  }

  // -------------------- WebGL コンテキスト --------------------
  function getWebGLContext(canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false };
    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    if (!gl) return { gl: null, ext: null };

    let halfFloat, supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : (halfFloat && halfFloat.HALF_FLOAT_OES);
    let formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }
    return { gl, ext: { formatRGBA, formatRG, formatR, halfFloatTexType, supportLinearFiltering: !!supportLinearFiltering } };
  }
  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F: return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F: return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default: return null;
      }
    }
    return { internalFormat, format };
  }
  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return status === gl.FRAMEBUFFER_COMPLETE;
  }

  // -------------------- シェーダ --------------------
  function compileShader(type, source, keywords) {
    source = addKeywords(source, keywords);
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(shader));
    return shader;
  }
  function addKeywords(source, keywords) {
    if (!keywords) return source;
    let prefix = '';
    keywords.forEach(k => { prefix += '#define ' + k + '\n'; });
    return prefix + source;
  }
  function createProgram(vs, fs) {
    const program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.warn(gl.getProgramInfoLog(program));
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  const baseVertex = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }`;

  const copyFrag = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }`;

  const clearFrag = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`;

  // clampMax：染料に書く時だけ上限（過飽和で黒が何秒も残るのを防ぐ）。
  // 速度に書く時は大きな値を渡して実質無効化。
  const splatFrag = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio;
    uniform vec3 color; uniform vec2 point; uniform float radius; uniform float clampMax;
    void main () {
      vec2 p = vUv - point.xy; p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(min(base + splat, vec3(clampMax)), 1.0);
    }`;

  // letterform splat：文字テクスチャの alpha 部分に毎フレーム墨を注入
  // （文字そのものが墨になり、縁から滲む）。
  // 上限は「その画素の alpha × uCap」＝透明度に比例。薄い縁は薄いまま飽和し、
  // ぼかしの裾まで真っ黒に潰れない。
  const letterSplatFrag = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget; uniform sampler2D uLetter;
    uniform float uStrength; uniform float uCap;
    void main () {
      vec4 base = texture2D(uTarget, vUv);
      float a = texture2D(uLetter, vUv).a;
      float add = min(uStrength * a, max(a * uCap - base.r, 0.0));
      gl_FragColor = vec4(base.rgb + vec3(add), 1.0);
    }`;

  const advectionFrag = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;
    uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st); vec2 fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
    #ifdef MANUAL_FILTERING
      vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
      vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
      vec4 result = texture2D(uSource, coord);
    #endif
      float decay = 1.0 + dissipation * dt;
      gl_FragColor = result / decay;
    }`;

  const divergenceFrag = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; }
      if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; }
      if (vB.y < 0.0) { B = -C.y; }
      float div = 0.5 * (R - L + T - B);
      gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }`;

  const curlFrag = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      float vorticity = R - L - T + B;
      gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }`;

  const vorticityFrag = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
    uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity += force * dt;
      velocity = min(max(velocity, -1000.0), 1000.0);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  const pressureFrag = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float divergence = texture2D(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }`;

  const gradientSubtractFrag = `
    precision mediump float; precision mediump sampler2D;
    varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
    uniform sampler2D uPressure; uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }`;

  // display：uWall の alpha がある画素は墨を 0 に戻す（paper-cutout reveal）
  // ＝墨が文字を避けて流れ、墨だまりの中で文字が紙色に浮かぶ
  const displayFrag = `
    precision highp float; precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture; uniform sampler2D uWall;
    uniform vec3 uInk; uniform float uWallEnabled;
    void main () {
      float d = texture2D(uTexture, vUv).r;
      float a = 1.0 - exp(-max(d, 0.0) * 3.4);   // 濃度→不透明度（黒く・不透明に）
      float wallA = texture2D(uWall, vUv).a * uWallEnabled;
      a *= 1.0 - wallA;
      gl_FragColor = vec4(uInk * a, a);          // プリマルチプライ（紙に正しく合成）
    }`;

  const baseVS = compileShader(gl.VERTEX_SHADER, baseVertex);
  const copyProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, copyFrag));
  const clearProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, clearFrag));
  const splatProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, splatFrag));
  const letterProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, letterSplatFrag));
  const advectionProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, advectionFrag, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']));
  const divergenceProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, divergenceFrag));
  const curlProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, curlFrag));
  const vorticityProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, vorticityFrag));
  const pressureProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, pressureFrag));
  const gradientProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, gradientSubtractFrag));
  const displayProg = createProgram(baseVS, compileShader(gl.FRAGMENT_SHADER, displayFrag));

  // -------------------- 描画バッファ --------------------
  const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return (target, clear) => {
      if (!target) { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
      else { gl.viewport(0, 0, target.width, target.height); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
      if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  let dye, velocity, divergence, curlFBO, pressure;

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT);
    const texelSizeX = 1.0 / w, texelSizeY = 1.0 / h;
    return {
      texture, fbo, width: w, height: h, texelSizeX, texelSizeY,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
  }
  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; }, set read(v) { fbo1 = v; },
      get write() { return fbo2; }, set write(v) { fbo2 = v; },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; }
    };
  }

  function getResolution(resolution) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1.0 / aspect;
    const min = Math.round(resolution), max = Math.round(resolution * aspect);
    if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
    return { width: min, height: max };
  }

  function initFramebuffers() {
    const simRes = getResolution(config.SIM_RESOLUTION);
    const dyeRes = getResolution(config.DYE_RESOLUTION);
    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA, rg = ext.formatRG, r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    gl.disable(gl.BLEND);

    dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curlFBO = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  }

  // -------------------- 墨の源テクスチャ（letterform） --------------------
  // 隠し 2D canvas に「墨の湧き出し口」を描き、texture 化して毎フレーム注入する。
  // 現在は brand/menu の全画面グラデーション塗り。wall（紙の切り抜き）機構は
  // シェーダー側に温存してあるが未使用（hasWall は常に false）。
  const letterCanvas = document.createElement('canvas');
  const letterCtx = letterCanvas.getContext('2d');
  const letterTex = createBlankTexture();
  const wallTex = createBlankTexture();
  let hasLetter = false, hasWall = false;

  function createBlankTexture() {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    return tex;
  }
  function uploadCanvas(tex, cnv) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cnv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  function renderScreenTextures() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    letterCanvas.width = w; letterCanvas.height = h;
    hasLetter = false;

    if (currentScreen === 'brand' || currentScreen === 'menu') {
      // 画面全体を墨で覆う源（中心ほど濃く、縁はわずかに薄く＝呼吸を残す）。
      // 白文字はこの墨の上に DOM で浮かぶ。brand→menu は暗転したまま。
      const g = letterCtx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      letterCtx.fillStyle = g;
      letterCtx.fillRect(0, 0, w, h);
      hasLetter = true;
    }
    if (hasLetter) uploadCanvas(letterTex, letterCanvas);
  }

  // -------------------- シミュレーション --------------------
  function step(dt, now) {
    gl.disable(gl.BLEND);

    // letterform：文字形から墨を注入（このモードで有効な時だけ）
    if (hasLetter && mode.letterK > 0.0) {
      gl.useProgram(letterProg.program);
      gl.uniform1i(letterProg.uniforms.uTarget, dye.read.attach(0));
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, letterTex);
      gl.uniform1i(letterProg.uniforms.uLetter, 1);
      gl.uniform1f(letterProg.uniforms.uStrength, mode.letterK);
      gl.uniform1f(letterProg.uniforms.uCap, DYE_CAP);
      blit(dye.write); dye.swap();
    }

    gl.useProgram(curlProg.program);
    gl.uniform2f(curlProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(curlFBO);

    gl.useProgram(vorticityProg.program);
    gl.uniform2f(vorticityProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProg.uniforms.uCurl, curlFBO.attach(1));
    gl.uniform1f(vorticityProg.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProg.uniforms.dt, dt);
    blit(velocity.write); velocity.swap();

    gl.useProgram(divergenceProg.program);
    gl.uniform2f(divergenceProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProg.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    gl.useProgram(clearProg.program);
    gl.uniform1i(clearProg.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, config.PRESSURE);
    blit(pressure.write); pressure.swap();

    gl.useProgram(pressureProg.program);
    gl.uniform2f(pressureProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProg.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProg.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    gl.useProgram(gradientProg.program);
    gl.uniform2f(gradientProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientProg.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientProg.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    // wash transition 中は散逸を強めて残留墨を拭き取る
    const inWash = now < washUntil;
    const velDiss = inWash ? Math.max(mode.velDiss * WASH_VEL_MUL, WASH_VEL_MIN) : mode.velDiss;
    const dyeDiss = inWash ? Math.max(mode.dyeDiss * WASH_DYE_MUL, WASH_DYE_MIN) : mode.dyeDiss;

    gl.useProgram(advectionProg.program);
    gl.uniform2f(advectionProg.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProg.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionProg.uniforms.dt, dt);
    gl.uniform1f(advectionProg.uniforms.dissipation, velDiss);
    blit(velocity.write); velocity.swap();

    gl.uniform1i(advectionProg.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProg.uniforms.uSource, dye.read.attach(1));
    if (!ext.supportLinearFiltering) gl.uniform2f(advectionProg.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1f(advectionProg.uniforms.dissipation, dyeDiss);
    blit(dye.write); dye.swap();
  }

  function render() {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // ストレートアルファで紙に合成
    gl.useProgram(displayProg.program);
    gl.uniform1i(displayProg.uniforms.uTexture, dye.read.attach(0));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, wallTex);
    gl.uniform1i(displayProg.uniforms.uWall, 1);
    gl.uniform1f(displayProg.uniforms.uWallEnabled, (mode.wall && hasWall) ? 1.0 : 0.0);
    gl.uniform3f(displayProg.uniforms.uInk, INK[0], INK[1], INK[2]);
    blit(null);
  }

  function splat(x, y, dx, dy, amount, radiusMul) {
    gl.disable(gl.BLEND);
    gl.useProgram(splatProg.program);
    gl.uniform1i(splatProg.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProg.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProg.uniforms.point, x, y);
    gl.uniform3f(splatProg.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProg.uniforms.radius, correctRadius(mode.cursorR * (radiusMul || 1.0) / 100.0));
    gl.uniform1f(splatProg.uniforms.clampMax, 1000000.0);   // 速度は制限しない
    blit(velocity.write); velocity.swap();

    gl.uniform1i(splatProg.uniforms.uTarget, dye.read.attach(0));
    const s = amount * mode.cursorI;
    gl.uniform3f(splatProg.uniforms.color, s, s, s);
    gl.uniform1f(splatProg.uniforms.clampMax, DYE_CAP);     // 染料は上限あり
    blit(dye.write); dye.swap();
  }
  function correctRadius(radius) {
    const aspect = canvas.width / canvas.height;
    if (aspect > 1) radius *= aspect;
    return radius;
  }

  // -------------------- サイズ --------------------
  function scaleByPixelRatio(v) { return Math.floor(v * Math.min(window.devicePixelRatio || 1, 2)); }
  function resizeCanvas() {
    const w = scaleByPixelRatio(canvas.clientWidth);
    const h = scaleByPixelRatio(canvas.clientHeight);
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w; canvas.height = h; return true;
    }
    return false;
  }

  // -------------------- 入力（指/マウス） --------------------
  // ポインタ：画面をなぞると墨が生まれ、動きの方向に流れる
  let lastPX = null, lastPY = null;
  let lastMoveT = 0;                 // dynamic dtScale 用（入力停止で早回し）
  const trail = [];                  // 直近の軌跡（bloom用）
  function pointerMove(clientX, clientY) {
    const x = clientX / window.innerWidth;
    const y = 1.0 - clientY / window.innerHeight;
    lastMoveT = performance.now();
    // カスケードの起点は「指を最初に置いた場所」に固定されているため、指が動いたあとも
    // その始点から滴が噴き続け、指のない場所から墨が湧いて見えていた。
    // 指が始点から離れたらカスケードを畳み、以降は指の軌跡だけに任せる。
    if (cascade.active) {
      const ddx = x - cascade.ox, ddy = y - cascade.oy;
      if (Math.hypot(ddx, ddy) > CASCADE_MOVE_TOL) cascade.active = false;
    }
    trail.push({ x: x, y: y, t: lastMoveT });
    if (trail.length > 32) trail.shift();
    if (lastPX !== null) {
      const dx = (x - lastPX) * mode.cursorF;
      const dy = (y - lastPY) * mode.cursorF;
      const moved = Math.hypot(dx, dy);
      if (moved > 0.5) splat(x, y, dx, dy, Math.min(1.0, 0.4 + moved / mode.cursorF * 6.0));
    }
    lastPX = x; lastPY = y;
  }
  window.addEventListener('mousemove', e => {
    // hoverInk:false の画面（sheet＝読み物）では、ボタンを押している間だけ描く。
    // スマホの touchmove は「指が触れている間」しか発火しないため、これで挙動が揃う。
    // （PCだけ、読むためにマウスを動かすだけで文字の裏に墨が湧いていた）
    if (!mode.hoverInk && !(e.buttons & 1)) {
      // 描かない間も位置だけ追う。押した瞬間に前回位置からの飛び線が出るのを防ぐ。
      lastPX = e.clientX / window.innerWidth;
      lastPY = 1.0 - e.clientY / window.innerHeight;
      return;
    }
    pointerMove(e.clientX, e.clientY);
  }, { passive: true });
  window.addEventListener('touchstart', e => {
    const t = e.touches[0]; if (!t) return;
    lastPX = t.clientX / window.innerWidth;          // 前回の指位置からの飛び線を防ぐ
    lastPY = 1.0 - t.clientY / window.innerHeight;
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    for (let i = 0; i < e.touches.length; i++) pointerMove(e.touches[i].clientX, e.touches[i].clientY);
  }, { passive: true });
  window.addEventListener('mouseleave', () => { lastPX = lastPY = null; });

  // -------------------- virtual sweep（画面遷移の帯ストローク） --------------------
  // 遷移1回＝画面外左→右へ 700ms の太い帯ストローク1本。線形補間で太さ均一。
  const sweep = { active: false, startT: 0, dur: 700, y: 0.06, px: -0.05 };
  let lastSweepT = 0;
  function startSweep(dir) {
    const now = performance.now();
    if (now - lastSweepT < 1200) return;   // 連射禁止スロットル
    lastSweepT = now;
    sweep.active = true;
    sweep.startT = now;
    sweep.y = (dir >= 0) ? 0.44 : 0.62;    // 画面中央帯（cutout 文字を横切って浮かび上がらせる）
    sweep.px = -0.05;
  }
  function updateSweep(now) {
    if (!sweep.active) return;
    const t = (now - sweep.startT) / sweep.dur;
    if (t >= 1) { sweep.active = false; return; }
    const x = -0.05 + 1.10 * t;
    const dx = x - sweep.px; sweep.px = x;
    if (Math.abs(dx) < 0.00005) return;
    splat(x, sweep.y, dx * mode.cursorF * 0.35, 0, 0.08, 3.0);   // 薄い刷毛跡（流れも弱め＝墨の吹き寄せ防止）
  }

  // -------------------- cascade（intro 初回タッチの墨カスケード） --------------------
  // 触れた場所を起点にランダムな滴を連鎖させる（swipe-to-enter 演出）。
  // CASCADE_MS = 滴が舞い続ける時間（以前の値: 1700）
  const CASCADE_MS = 3800;
  // 指が始点からこれだけ離れたらカスケードを畳む（画面比での距離）。
  // 手ぶれ程度では消えず、意図して動かしたら消える大きさにしてある。
  const CASCADE_MOVE_TOL = 0.05;
  const cascade = { active: false, startT: 0, ox: 0.5, oy: 0.5, nextT: 0 };
  function cascadeAt(clientX, clientY) {
    const x = clientX / window.innerWidth;
    const y = 1.0 - clientY / window.innerHeight;
    const now = performance.now();
    cascade.active = true; cascade.startT = now; cascade.nextT = 0;
    cascade.ox = x; cascade.oy = y;
    trail.push({ x, y, t: now });
    splat(x, y, 0, 120, 1.0, 0.9);   // まず触れた場所にひと滴
  }
  function updateCascade(now) {
    if (!cascade.active) return;
    const elapsed = now - cascade.startT;
    if (elapsed > CASCADE_MS) { cascade.active = false; return; }
    if (now < cascade.nextT) return;
    cascade.nextT = now + 150 + (elapsed / CASCADE_MS) * 220;   // だんだん間遠に
    // 墨は「指を置いた場所」からのみ出す。
    // 以前はここで半分を画面中央寄り・半分を起点から±0.25ずらした位置に散らしていたが、
    // 指と無関係な場所から墨が湧いて見えるため、滴の発生位置は起点に固定した。
    // 広がりは位置ではなく、下の速度ベクトル（角度と強さ）だけで作る。
    const tx = cascade.ox, ty = cascade.oy;
    const ang = Math.random() * Math.PI * 2;
    const spd = 300 + Math.random() * 500;   // 強すぎると画面端で乱れるため控えめに
    trail.push({ x: tx, y: ty, t: now });
    if (trail.length > 32) trail.shift();
    splat(tx, ty, Math.cos(ang) * spd, Math.sin(ang) * spd, 0.7, 0.8);
  }

  // -------------------- bloom（画面2へ移る時：軌跡に沿って墨が咲く） --------------------
  function bloom() {
    const now = performance.now();
    let pts = trail.filter(p => now - p.t < 1400);
    // 直近1400msに軌跡が無い場合の受け皿。以前はここで画面中央(x=0.5)の固定3点に
    // 大きな滴を落としていたため、指と無関係な場所に墨が湧いて見えることがあった。
    // 時間切れでも「最後に触れた場所」を使い、指から出たように見せる。
    if (pts.length < 2) pts = trail.slice(-3);
    if (pts.length < 1) pts = [{ x: cascade.ox, y: cascade.oy }];
    const N = Math.min(8, pts.length);
    const items = [];
    for (let i = 0; i < N; i++) {
      const idx = Math.floor(i * (pts.length - 1) / Math.max(1, N - 1));
      const p = pts[idx];
      const q = pts[Math.min(idx + 1, pts.length - 1)];
      items.push({ x: p.x, y: p.y, dx: (q.x - p.x) * 2600, dy: (q.y - p.y) * 2600 });
    }
    // フレーム同期で2発ずつ描く（1フレームに負荷を集中させない＝カクつかない）
    let i = 0;
    function pump() {
      for (let k = 0; k < 2 && i < items.length; k++, i++) {
        const it = items[i];
        splat(it.x, it.y, it.dx, it.dy, 1.4, 1.7);   // 咲く時だけ大きな滴に
      }
      if (i < items.length) requestAnimationFrame(pump);
    }
    requestAnimationFrame(pump);
  }

  // 染料全体を一括で薄める（遷移の瞬間の「拭き取り」）
  function fadeDye(f) {
    gl.disable(gl.BLEND);
    gl.useProgram(clearProg.program);
    gl.uniform1i(clearProg.uniforms.uTexture, dye.read.attach(0));
    gl.uniform1f(clearProg.uniforms.value, f);
    blit(dye.write); dye.swap();
  }

  // -------------------- 画面切替（モード差し替え＋wash＋文字テクスチャ更新） --------------------
  function setScreen(id) {
    const key = MODES[id] ? id : 'sheet';
    const prev = currentScreen;
    currentScreen = key;
    mode = MODES[key];
    if (mode.wash && key !== prev) {
      washUntil = performance.now() + WASH_MS;
      fadeDye(0.25);   // まず一段薄めてから wash で拭き切る
    }
    // レイアウト確定後に見出しを描き直す（フェード中でも rect は取れる）
    requestAnimationFrame(renderScreenTextures);
  }

  window.InkFluid = { bloom: bloom, setScreen: setScreen, sweep: startSweep, cascadeAt: cascadeAt };

  // -------------------- ループ --------------------
  // DT_BOOST = 入力が止まっている間の早回し倍率／DT_LERP = そこへ寄せる速さ（1フレームあたり）
  // 以前の値: DT_BOOST 2.0, DT_LERP 0.3。この組み合わせだと指を離した0.13秒後から
  // わずか0.15秒で2倍速に達し、墨が「ブワッ」と急加速して見えていた。
  // 余韻を早く収める意図は残したいので、倍率を下げ、加速も約0.8秒かけて緩やかにする。
  const DT_BOOST = 1.4, DT_LERP = 0.06;
  let dynDtScale = 1.0;
  let lastTime = performance.now();
  function update() {
    const now = performance.now();
    let dt = (now - lastTime) / 1000; dt = Math.min(dt, 0.033); lastTime = now;
    if (resizeCanvas()) { initFramebuffers(); renderScreenTextures(); }
    if (!document.hidden) {
      updateCascade(now);
      updateSweep(now);
      // dynamic dtScale：入力が止まっている間はシムを2倍速にして余韻を早く落ち着かせる
      const active = (now - lastMoveT < 130) || sweep.active || cascade.active;
      const target = mode.dtScale * (active ? 1.0 : DT_BOOST);
      dynDtScale += (target - dynDtScale) * DT_LERP;
      step(dt * dynDtScale, now);
      render();
    }
    requestAnimationFrame(update);
  }

  resizeCanvas();
  initFramebuffers();
  renderScreenTextures();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => renderScreenTextures());   // フォント確定後に描き直し
  }
  window.addEventListener('resize', () => { if (resizeCanvas()) initFramebuffers(); renderScreenTextures(); });
  requestAnimationFrame(update);
})();
