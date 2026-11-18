import{r as e}from"./chunk-QTnfLwEv.js";import{t}from"./react-sKtkuLrH.js";import{t as n}from"./jsx-runtime-DsKLSDJq.js";import{Jt as r,Mt as i,Yt as a,_ as o,d as s,f as c,n as l,nt as u}from"./three.module-DJ81ilGZ.js";import{a as d,r as f,s as p}from"./react-three-fiber.esm-ct5DerrN.js";var m=e(t(),1),h=Object.defineProperty,g=(e,t,n)=>t in e?h(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n,_=(e,t,n)=>(g(e,typeof t==`symbol`?t:t+``,n),n);function v(e,t,n,r,i){let a;if(e=e.subarray||e.slice?e:e.buffer,n=n.subarray||n.slice?n:n.buffer,e=t?e.subarray?e.subarray(t,i&&t+i):e.slice(t,i&&t+i):e,n.set)n.set(e,r);else for(a=0;a<e.length;a++)n[a+r]=e[a];return n}function y(e){return e instanceof Float32Array?e:e instanceof c?e.getAttribute(`position`).array:e.map(e=>{let t=Array.isArray(e);return e instanceof a?[e.x,e.y,e.z]:e instanceof r?[e.x,e.y,0]:t&&e.length===3?[e[0],e[1],e[2]]:t&&e.length===2?[e[0],e[1],0]:e}).flat()}var b=class extends c{constructor(){super(),_(this,`type`,`MeshLine`),_(this,`isMeshLine`,!0),_(this,`positions`,[]),_(this,`previous`,[]),_(this,`next`,[]),_(this,`side`,[]),_(this,`width`,[]),_(this,`indices_array`,[]),_(this,`uvs`,[]),_(this,`counters`,[]),_(this,`widthCallback`,null),_(this,`_attributes`),_(this,`_points`,[]),_(this,`points`),_(this,`matrixWorld`,new u),Object.defineProperties(this,{points:{enumerable:!0,get(){return this._points},set(e){this.setPoints(e,this.widthCallback)}}})}setMatrixWorld(e){this.matrixWorld=e}setPoints(e,t){if(e=y(e),this._points=e,this.widthCallback=t??null,this.positions=[],this.counters=[],e.length&&e[0]instanceof a)for(let t=0;t<e.length;t++){let n=e[t],r=t/(e.length-1);this.positions.push(n.x,n.y,n.z),this.positions.push(n.x,n.y,n.z),this.counters.push(r),this.counters.push(r)}else for(let t=0;t<e.length;t+=3){let n=t/(e.length-1);this.positions.push(e[t],e[t+1],e[t+2]),this.positions.push(e[t],e[t+1],e[t+2]),this.counters.push(n),this.counters.push(n)}this.process()}compareV3(e,t){let n=e*6,r=t*6;return this.positions[n]===this.positions[r]&&this.positions[n+1]===this.positions[r+1]&&this.positions[n+2]===this.positions[r+2]}copyV3(e){let t=e*6;return[this.positions[t],this.positions[t+1],this.positions[t+2]]}process(){let e=this.positions.length/6;this.previous=[],this.next=[],this.side=[],this.width=[],this.indices_array=[],this.uvs=[];let t,n;n=this.compareV3(0,e-1)?this.copyV3(e-2):this.copyV3(0),this.previous.push(n[0],n[1],n[2]),this.previous.push(n[0],n[1],n[2]);for(let r=0;r<e;r++){if(this.side.push(1),this.side.push(-1),t=this.widthCallback?this.widthCallback(r/(e-1)):1,this.width.push(t),this.width.push(t),this.uvs.push(r/(e-1),0),this.uvs.push(r/(e-1),1),r<e-1){n=this.copyV3(r),this.previous.push(n[0],n[1],n[2]),this.previous.push(n[0],n[1],n[2]);let e=r*2;this.indices_array.push(e,e+1,e+2),this.indices_array.push(e+2,e+1,e+3)}r>0&&(n=this.copyV3(r),this.next.push(n[0],n[1],n[2]),this.next.push(n[0],n[1],n[2]))}n=this.compareV3(e-1,0)?this.copyV3(1):this.copyV3(e-1),this.next.push(n[0],n[1],n[2]),this.next.push(n[0],n[1],n[2]),!this._attributes||this._attributes.position.count!==this.counters.length?this._attributes={position:new s(new Float32Array(this.positions),3),previous:new s(new Float32Array(this.previous),3),next:new s(new Float32Array(this.next),3),side:new s(new Float32Array(this.side),1),width:new s(new Float32Array(this.width),1),uv:new s(new Float32Array(this.uvs),2),index:new s(new Uint16Array(this.indices_array),1),counters:new s(new Float32Array(this.counters),1)}:(this._attributes.position.copyArray(new Float32Array(this.positions)),this._attributes.position.needsUpdate=!0,this._attributes.previous.copyArray(new Float32Array(this.previous)),this._attributes.previous.needsUpdate=!0,this._attributes.next.copyArray(new Float32Array(this.next)),this._attributes.next.needsUpdate=!0,this._attributes.side.copyArray(new Float32Array(this.side)),this._attributes.side.needsUpdate=!0,this._attributes.width.copyArray(new Float32Array(this.width)),this._attributes.width.needsUpdate=!0,this._attributes.uv.copyArray(new Float32Array(this.uvs)),this._attributes.uv.needsUpdate=!0,this._attributes.index.copyArray(new Uint16Array(this.indices_array)),this._attributes.index.needsUpdate=!0),this.setAttribute(`position`,this._attributes.position),this.setAttribute(`previous`,this._attributes.previous),this.setAttribute(`next`,this._attributes.next),this.setAttribute(`side`,this._attributes.side),this.setAttribute(`width`,this._attributes.width),this.setAttribute(`uv`,this._attributes.uv),this.setAttribute(`counters`,this._attributes.counters),this.setAttribute(`position`,this._attributes.position),this.setAttribute(`previous`,this._attributes.previous),this.setAttribute(`next`,this._attributes.next),this.setAttribute(`side`,this._attributes.side),this.setAttribute(`width`,this._attributes.width),this.setAttribute(`uv`,this._attributes.uv),this.setAttribute(`counters`,this._attributes.counters),this.setIndex(this._attributes.index),this.computeBoundingSphere(),this.computeBoundingBox()}advance({x:e,y:t,z:n}){let r=this._attributes.position.array,i=this._attributes.previous.array,a=this._attributes.next.array,o=r.length;v(r,0,i,0,o),v(r,6,r,0,o-6),r[o-6]=e,r[o-5]=t,r[o-4]=n,r[o-3]=e,r[o-2]=t,r[o-1]=n,v(r,6,a,0,o-6),a[o-6]=e,a[o-5]=t,a[o-4]=n,a[o-3]=e,a[o-2]=t,a[o-1]=n,this._attributes.position.needsUpdate=!0,this._attributes.previous.needsUpdate=!0,this._attributes.next.needsUpdate=!0}},x=`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  #include <fog_pars_vertex>
  #include <clipping_planes_pars_vertex>

  attribute vec3 previous;
  attribute vec3 next;
  attribute float side;
  attribute float width;
  attribute float counters;
  
  uniform vec2 resolution;
  uniform float lineWidth;
  uniform vec3 color;
  uniform float opacity;
  uniform float sizeAttenuation;
  
  varying vec2 vUV;
  varying vec4 vColor;
  varying float vCounters;
  
  vec2 fix(vec4 i, float aspect) {
    vec2 res = i.xy / i.w;
    res.x *= aspect;
    return res;
  }
  
  void main() {
    float aspect = resolution.x / resolution.y;
    vColor = vec4(color, opacity);
    vUV = uv;
    vCounters = counters;
  
    mat4 m = projectionMatrix * modelViewMatrix;
    vec4 finalPosition = m * vec4(position, 1.0) * aspect;
    vec4 prevPos = m * vec4(previous, 1.0);
    vec4 nextPos = m * vec4(next, 1.0);
  
    vec2 currentP = fix(finalPosition, aspect);
    vec2 prevP = fix(prevPos, aspect);
    vec2 nextP = fix(nextPos, aspect);
  
    float w = lineWidth * width;
  
    vec2 dir;
    if (nextP == currentP) dir = normalize(currentP - prevP);
    else if (prevP == currentP) dir = normalize(nextP - currentP);
    else {
      vec2 dir1 = normalize(currentP - prevP);
      vec2 dir2 = normalize(nextP - currentP);
      dir = normalize(dir1 + dir2);
  
      vec2 perp = vec2(-dir1.y, dir1.x);
      vec2 miter = vec2(-dir.y, dir.x);
      //w = clamp(w / dot(miter, perp), 0., 4. * lineWidth * width);
    }
  
    //vec2 normal = (cross(vec3(dir, 0.), vec3(0., 0., 1.))).xy;
    vec4 normal = vec4(-dir.y, dir.x, 0., 1.);
    normal.xy *= .5 * w;
    //normal *= projectionMatrix;
    if (sizeAttenuation == 0.) {
      normal.xy *= finalPosition.w;
      normal.xy /= (vec4(resolution, 0., 1.) * projectionMatrix).xy * aspect;
    }
  
    finalPosition.xy += normal.xy * side;
    gl_Position = finalPosition;
    #include <logdepthbuf_vertex>
    #include <fog_vertex>
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    #include <clipping_planes_vertex>
    #include <fog_vertex>
  }
`,S=`
  #include <fog_pars_fragment>
  #include <logdepthbuf_pars_fragment>
  #include <clipping_planes_pars_fragment>
  
  uniform sampler2D map;
  uniform sampler2D alphaMap;
  uniform float useGradient;
  uniform float useMap;
  uniform float useAlphaMap;
  uniform float useDash;
  uniform float dashArray;
  uniform float dashOffset;
  uniform float dashRatio;
  uniform float visibility;
  uniform float alphaTest;
  uniform vec2 repeat;
  uniform vec3 gradient[2];
  
  varying vec2 vUV;
  varying vec4 vColor;
  varying float vCounters;
  
  void main() {
    #include <logdepthbuf_fragment>
    vec4 diffuseColor = vColor;
    if (useGradient == 1.) diffuseColor = vec4(mix(gradient[0], gradient[1], vCounters), 1.0);
    if (useMap == 1.) diffuseColor *= texture2D(map, vUV * repeat);
    if (useAlphaMap == 1.) diffuseColor.a *= texture2D(alphaMap, vUV * repeat).a;
    if (diffuseColor.a < alphaTest) discard;
    if (useDash == 1.) diffuseColor.a *= ceil(mod(vCounters + dashOffset, dashArray) - (dashArray * dashRatio));
    diffuseColor.a *= step(vCounters, visibility);
    #include <clipping_planes_fragment>
    gl_FragColor = diffuseColor;     
    #include <fog_fragment>
    #include <tonemapping_fragment>
    #include <${parseInt(`184`.replace(/\D+/g,``))>=154?`colorspace_fragment`:`encodings_fragment`}>
  }
`,C=class extends i{constructor(e){super({uniforms:{...l.fog,lineWidth:{value:1},map:{value:null},useMap:{value:0},alphaMap:{value:null},useAlphaMap:{value:0},color:{value:new o(16777215)},gradient:{value:[new o(16711680),new o(65280)]},opacity:{value:1},resolution:{value:new r(1,1)},sizeAttenuation:{value:1},dashArray:{value:0},dashOffset:{value:0},dashRatio:{value:.5},useDash:{value:0},useGradient:{value:0},visibility:{value:1},alphaTest:{value:0},repeat:{value:new r(1,1)}},vertexShader:x,fragmentShader:S}),_(this,`lineWidth`),_(this,`map`),_(this,`useMap`),_(this,`alphaMap`),_(this,`useAlphaMap`),_(this,`color`),_(this,`gradient`),_(this,`resolution`),_(this,`sizeAttenuation`),_(this,`dashArray`),_(this,`dashOffset`),_(this,`dashRatio`),_(this,`useDash`),_(this,`useGradient`),_(this,`visibility`),_(this,`repeat`),this.type=`MeshLineMaterial`,Object.defineProperties(this,{lineWidth:{enumerable:!0,get(){return this.uniforms.lineWidth.value},set(e){this.uniforms.lineWidth.value=e}},map:{enumerable:!0,get(){return this.uniforms.map.value},set(e){this.uniforms.map.value=e}},useMap:{enumerable:!0,get(){return this.uniforms.useMap.value},set(e){this.uniforms.useMap.value=e}},alphaMap:{enumerable:!0,get(){return this.uniforms.alphaMap.value},set(e){this.uniforms.alphaMap.value=e}},useAlphaMap:{enumerable:!0,get(){return this.uniforms.useAlphaMap.value},set(e){this.uniforms.useAlphaMap.value=e}},color:{enumerable:!0,get(){return this.uniforms.color.value},set(e){this.uniforms.color.value=e}},gradient:{enumerable:!0,get(){return this.uniforms.gradient.value},set(e){this.uniforms.gradient.value=e}},opacity:{enumerable:!0,get(){return this.uniforms.opacity.value},set(e){this.uniforms.opacity.value=e}},resolution:{enumerable:!0,get(){return this.uniforms.resolution.value},set(e){this.uniforms.resolution.value.copy(e)}},sizeAttenuation:{enumerable:!0,get(){return this.uniforms.sizeAttenuation.value},set(e){this.uniforms.sizeAttenuation.value=e}},dashArray:{enumerable:!0,get(){return this.uniforms.dashArray.value},set(e){this.uniforms.dashArray.value=e,this.useDash=e===0?0:1}},dashOffset:{enumerable:!0,get(){return this.uniforms.dashOffset.value},set(e){this.uniforms.dashOffset.value=e}},dashRatio:{enumerable:!0,get(){return this.uniforms.dashRatio.value},set(e){this.uniforms.dashRatio.value=e}},useDash:{enumerable:!0,get(){return this.uniforms.useDash.value},set(e){this.uniforms.useDash.value=e}},useGradient:{enumerable:!0,get(){return this.uniforms.useGradient.value},set(e){this.uniforms.useGradient.value=e}},visibility:{enumerable:!0,get(){return this.uniforms.visibility.value},set(e){this.uniforms.visibility.value=e}},alphaTest:{enumerable:!0,get(){return this.uniforms.alphaTest.value},set(e){this.uniforms.alphaTest.value=e}},repeat:{enumerable:!0,get(){return this.uniforms.repeat.value},set(e){this.uniforms.repeat.value.copy(e)}}}),this.setValues(e)}copy(e){return super.copy(e),this.lineWidth=e.lineWidth,this.map=e.map,this.useMap=e.useMap,this.alphaMap=e.alphaMap,this.useAlphaMap=e.useAlphaMap,this.color.copy(e.color),this.gradient=e.gradient,this.opacity=e.opacity,this.resolution.copy(e.resolution),this.sizeAttenuation=e.sizeAttenuation,this.dashArray=e.dashArray,this.dashOffset=e.dashOffset,this.dashRatio=e.dashRatio,this.useDash=e.useDash,this.useGradient=e.useGradient,this.visibility=e.visibility,this.alphaTest=e.alphaTest,this.repeat.copy(e.repeat),this}},w=n(),T=new a,E=(0,m.forwardRef)(function({target:e,width:t=.2,length:n=1,decay:i=1,color:a=`hotpink`,attenuation:o},s){let c=p(e=>e.size),l=p(e=>e.scene),u=Math.max(2,Math.round(n*10)),h=(0,m.useRef)(o);h.current=o;let g=(0,m.useMemo)(()=>{let e=new b;return e.setPoints(new Float32Array(u*3),h.current),e},[u]);(0,m.useEffect)(()=>()=>g.dispose(),[g]);let _=(0,m.useMemo)(()=>new C({lineWidth:.1*t,color:a,sizeAttenuation:1,resolution:new r(1,1)}),[t,a]);(0,m.useEffect)(()=>()=>_.dispose(),[_]),(0,m.useEffect)(()=>{_.uniforms.resolution.value.set(c.width,c.height)},[_,c]);let v=(0,m.useRef)({points:new Float32Array(u*3),primed:!1,acc:0,still:0,lx:0,ly:0,lz:0});return v.current.points.length!==u*3&&(v.current={...v.current,points:new Float32Array(u*3),primed:!1}),d((t,n)=>{let r=e.current;if(!r)return;let a=v.current,o=a.points;if(r.getWorldPosition(T),!a.primed){for(let e=0;e<u;e++)o.set([T.x,T.y,T.z],e*3);a.primed=!0,a.still=0,D(g,o,u);return}a.acc+=Math.min(n,.25)*Math.ceil(i)*60;let s=Math.floor(a.acc);if(s<=0)return;a.acc-=s;let c=T.x!==a.lx||T.y!==a.ly||T.z!==a.lz;if(!(!c&&a.still>=u)){a.still=c?s:a.still+s,a.lx=T.x,a.ly=T.y,a.lz=T.z,s=Math.min(s,u),o.copyWithin(0,s*3);for(let e=u-s;e<u;e++)o[e*3]=T.x,o[e*3+1]=T.y,o[e*3+2]=T.z;D(g,o,u)}}),f((0,w.jsx)(`mesh`,{ref:s,geometry:g,material:_,frustumCulled:!1,raycast:()=>null}),l)});function D(e,t,n){let r=e.getAttribute(`position`),i=e.getAttribute(`previous`),a=e.getAttribute(`next`),o=r.array,s=i.array,c=a.array;for(let e=0;e<n;e++){let r=e*3,i=Math.max(0,e-1)*3,a=Math.min(n-1,e+1)*3;for(let n=0;n<2;n++){let l=(e*2+n)*3;o[l]=t[r],o[l+1]=t[r+1],o[l+2]=t[r+2],s[l]=t[i],s[l+1]=t[i+1],s[l+2]=t[i+2],c[l]=t[a],c[l+1]=t[a+1],c[l+2]=t[a+2]}}r.needsUpdate=!0,i.needsUpdate=!0,a.needsUpdate=!0}var O=`
  varying vec3 vPos;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  void main() {
    vPos = normalize(position);
    vViewNormal = normalize(normalMatrix * normal);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-viewPosition.xyz);
    gl_Position = projectionMatrix * viewPosition;
  }
`,k=`
  uniform float uTime;
  varying vec3 vPos;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
  float fresnel(float power) { return pow(1.0 - max(dot(normalize(vViewNormal), normalize(vViewDir)), 0.0), power); }
`,A={fire:`
    void main() {
      float n = fbm(vPos * 3.0 + vec3(0.0, -uTime * 1.8, 0.0));
      float flame = smoothstep(0.25, 0.85, n + vPos.y * 0.25);
      vec3 c = mix(vec3(0.55, 0.05, 0.0), vec3(1.0, 0.45, 0.0), flame);
      c = mix(c, vec3(1.0, 0.92, 0.35), smoothstep(0.7, 1.0, n));
      c += fresnel(2.0) * vec3(1.0, 0.35, 0.05);
      gl_FragColor = vec4(c, 1.0);
    }`,ice:`
    void main() {
      float facets = noise(floor(vPos * 7.0) + 0.5);
      vec3 c = mix(vec3(0.25, 0.6, 0.85), vec3(0.62, 0.86, 0.98), facets);
      float frost = fbm(vPos * 6.0);
      c = mix(c, vec3(0.92, 0.98, 1.0), smoothstep(0.6, 0.85, frost) * 0.5);
      float sparkle = pow(noise(vPos * 40.0 + uTime * 0.6), 18.0) * 3.0;
      c += sparkle + fresnel(2.5) * vec3(0.5, 0.8, 1.0);
      gl_FragColor = vec4(c, 1.0);
    }`,galaxy:`
    void main() {
      float a = atan(vPos.z, vPos.x) + uTime * 0.25;
      vec3 q = vec3(cos(a), vPos.y * 1.6, sin(a));
      float neb = fbm(q * 2.5 + vec3(uTime * 0.05));
      vec3 c = mix(vec3(0.05, 0.02, 0.15), vec3(0.45, 0.15, 0.7), neb);
      c = mix(c, vec3(0.1, 0.55, 0.9), smoothstep(0.55, 0.8, fbm(q * 4.0)) * 0.6);
      float star = step(0.985, hash(floor(vPos * 60.0))) * (0.6 + 0.4 * sin(uTime * 4.0 + hash(floor(vPos * 60.0)) * 30.0));
      c += star + fresnel(3.0) * vec3(0.5, 0.4, 1.0);
      gl_FragColor = vec4(c, 1.0);
    }`,lava:`
    void main() {
      float n = fbm(vPos * 4.0 + vec3(uTime * 0.15));
      float crack = 1.0 - smoothstep(0.0, 0.06, abs(n - 0.5));
      vec3 rock = mix(vec3(0.08, 0.05, 0.04), vec3(0.2, 0.12, 0.08), fbm(vPos * 9.0));
      vec3 glow = mix(vec3(1.0, 0.25, 0.0), vec3(1.0, 0.75, 0.2), 0.5 + 0.5 * sin(uTime * 2.0));
      gl_FragColor = vec4(rock + crack * glow * 1.4 + fresnel(3.0) * vec3(0.6, 0.15, 0.0), 1.0);
    }`,void:`
    void main() {
      float swirl = fbm(vPos * 3.0 + vec3(0.0, uTime * 0.3, 0.0));
      vec3 c = vec3(0.02, 0.0, 0.05) + swirl * vec3(0.06, 0.0, 0.12);
      float rim = fresnel(2.2) * (0.75 + 0.25 * sin(uTime * 3.0));
      gl_FragColor = vec4(c + rim * vec3(0.65, 0.3, 1.0), 1.0);
    }`,holo:`
    vec3 spectrum(float h) { return clamp(abs(fract(h + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
    void main() {
      float f = fresnel(1.5);
      vec3 c = spectrum(f * 0.8 + vPos.y * 0.3 + uTime * 0.15) * 0.8 + 0.25;
      float scan = 0.85 + 0.15 * sin(vPos.y * 80.0 - uTime * 6.0);
      gl_FragColor = vec4(c * scan + f * 0.5, 1.0);
    }`,storm:`
    void main() {
      vec3 c = mix(vec3(0.03, 0.06, 0.18), vec3(0.1, 0.18, 0.4), fbm(vPos * 3.0));
      float n = fbm(vPos * 5.0 + vec3(floor(uTime * 8.0) * 0.37));
      float bolt = 1.0 - smoothstep(0.0, 0.025, abs(n - 0.5));
      float flash = step(0.6, fract(sin(floor(uTime * 8.0)) * 43758.5));
      c += bolt * flash * vec3(0.6, 0.9, 1.0) * 1.8 + fresnel(2.5) * vec3(0.3, 0.6, 1.0);
      gl_FragColor = vec4(c, 1.0);
    }`},j=`gl_FragColor = sRGBTransferEOTF(gl_FragColor);
  #include <colorspace_fragment>`;function M(e){return`${k}${A[e].replace(`void main()`,`void effectMain()`)}
  void main() { effectMain(); ${j} }`}function N(e){return`${k}uniform float uAlpha;\n${A[e].replace(`void main()`,`void effectMain()`)}
  void main() { effectMain(); gl_FragColor.a *= uAlpha; ${j} }`}function P(e,t,n){switch(e){case`fire`:{let e=.5+.5*Math.sin(t*23)*Math.sin(t*7.3);return n.setRGB(1,.25+.55*e,.05*e)}case`frost`:{let e=.5+.5*Math.sin(t*3);return n.setRGB(.7+.3*e,.88+.12*e,1)}case`rainbow`:return n.setHSL(t*.35%1,.9,.6);case`spark`:return Math.sin(t*41)*Math.sin(t*17)>.2?n.setRGB(1,1,1):n.setRGB(.35,.95,1);case`ghost`:{let e=.5+.5*Math.sin(t*2);return n.setRGB(.72-.18*e,.72-.3*e,.8+.2*e)}}}export{E as a,P as i,M as n,N as r,O as t};