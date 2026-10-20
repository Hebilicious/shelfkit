/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}

declare module "@shelfkit/tokens/css";

/** The File System Access API's directory picker, which TypeScript's DOM library does not declare yet. */
interface DirectoryPickerOptions {
  readonly id?: string;
  readonly mode?: "read" | "readwrite";
}

interface Window {
  showDirectoryPicker: (
    options?: DirectoryPickerOptions
  ) => Promise<FileSystemDirectoryHandle>;
}
