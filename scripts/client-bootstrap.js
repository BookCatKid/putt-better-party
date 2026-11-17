const bpRoot = Xn({ component: () => (0, k.jsx)(or, {}) });
const bpHome = Jn({
  getParentRoute: () => bpRoot,
  path: `/`,
  component: () => (location.replace('/home'), null),
});
const bpParty = Jn({
  getParentRoute: () => bpRoot,
  path: `/party/$code`,
  component: M(() => import('./party._code-D3a-IB4-.js'), 'component'),
});
const bpRouter = dr({ routeTree: bpRoot.addChildren([bpHome, bpParty]), defaultPreload: false });
window.__TSS_START_OPTIONS__ = { serializationAdapters: [] };
(0, Hs.createRoot)(document.getElementById('app')).render((0, k.jsx)(mr, { router: bpRouter }));
