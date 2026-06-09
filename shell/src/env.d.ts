// Ambient declaration for electron-vite's `?asset` import suffix. The
// plugin copies the referenced file into the main-process bundle output
// and the import resolves to its on-disk path at runtime (dev + packaged).
// electron-vite ships this in electron-vite/node, but the shell tsconfig
// scopes `types` to ["node", "electron"], so we declare the one suffix we
// actually use here rather than widening the ambient set.
declare module '*?asset' {
  const src: string;
  export default src;
}
