// wa-sqlite trae tipos para su API y para el módulo de WebAssembly, pero no para los VFS de
// ejemplo, que son JavaScript sin anotar. Se declara aquí lo que hace falta del único que
// usamos, en vez de instalar nada.

declare module 'wa-sqlite/src/examples/AccessHandlePoolVFS.js' {
  export class AccessHandlePoolVFS {
    constructor(directorio: string);
    readonly name: string;
    readonly isReady: Promise<unknown>;
  }
}
