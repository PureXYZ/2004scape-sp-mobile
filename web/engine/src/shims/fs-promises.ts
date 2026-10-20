// `fs/promises` / `node:fs/promises` over the vfs.
import { promises } from './fs.js';

export const { readFile, writeFile, appendFile, mkdir, readdir, stat, lstat, unlink, rm, rename, copyFile, access } = promises;
export default promises;
